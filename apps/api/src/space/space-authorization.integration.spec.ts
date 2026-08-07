import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationPolicy } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { RedisService } from '../infrastructure/redis.service.js';
import { GroupService } from '../tenant/group.service.js';
import { assertLocalIntegrationRunner } from '../testing/integration-test.guard.js';
import { AclService } from './acl.service.js';
import { SpaceMemberService } from './space-member.service.js';
import { SpaceService } from './space.service.js';

const integrationEnabled = process.env['DAM_SPACE_INTEGRATION_TESTS'] === '1';
assertLocalIntegrationRunner(integrationEnabled);
const integration = integrationEnabled ? describe : describe.skip;

if (integrationEnabled) {
  const rootEnvPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(rootEnvPath)) {
    process.loadEnvFile(rootEnvPath);
  }
}

integration('A/B company and group-shared space authorization', () => {
  const prisma = new PrismaService();
  const cache = new Map<string, unknown>();
  const redis = {
    getJson<T>(key: string): Promise<T | null> {
      return Promise.resolve((cache.get(key) as T | undefined) ?? null);
    },
    setJson(key: string, value: unknown): Promise<void> {
      cache.set(key, value);
      return Promise.resolve();
    },
  } as unknown as RedisService;
  const authorization = new AuthorizationService(
    prisma,
    redis,
    new AuthorizationPolicy(),
    new ConfigService({ AUTHORIZATION_CACHE_TTL_SECONDS: 300 }),
  );
  const spaces = new SpaceService(prisma, authorization);
  const members = new SpaceMemberService(prisma, authorization);
  const acl = new AclService(prisma, authorization);
  const groups = new GroupService(prisma, authorization);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('enforces private, shared-logistics, role, ACL, cache, and Tenant boundaries', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const platformAdmin = await prisma.role.findUniqueOrThrow({
      where: { code: 'platform_admin' },
    });
    const tenant = await prisma.tenant.create({
      data: {
        code: `space-auth-${suffix}`,
        name: 'A/B Group Authorization Acceptance',
        securityPolicy: { create: {} },
      },
    });
    const [companyA, companyB] = await Promise.all([
      prisma.organization.create({
        data: { tenantId: tenant.id, code: `company-a-${suffix}`, name: 'Company A' },
      }),
      prisma.organization.create({
        data: { tenantId: tenant.id, code: `company-b-${suffix}`, name: 'Company B' },
      }),
    ]);
    const [administrator, companyAUser, companyBUser, logisticsUser] = await Promise.all([
      createUser(prisma, tenant.id, `space-admin-${suffix}`, 'Group Space Administrator'),
      createUser(prisma, tenant.id, `company-a-user-${suffix}`, 'Company A Employee'),
      createUser(prisma, tenant.id, `company-b-user-${suffix}`, 'Company B Employee'),
      createUser(prisma, tenant.id, `logistics-user-${suffix}`, 'Shared Logistics Employee'),
    ]);
    await prisma.organizationMembership.createMany({
      data: [
        { organizationId: companyA.id, userId: companyAUser.id, isPrimary: true },
        { organizationId: companyB.id, userId: companyBUser.id, isPrimary: true },
      ],
    });
    await prisma.roleBinding.create({
      data: {
        tenantId: tenant.id,
        roleId: platformAdmin.id,
        principalType: 'USER',
        principalId: administrator.id,
        scopeType: 'TENANT',
        scopeId: tenant.id,
      },
    });
    const sharedLogisticsGroup = await prisma.group.create({
      data: {
        tenantId: tenant.id,
        name: `Shared Logistics ${suffix}`,
        type: 'DEPARTMENT',
      },
    });
    const otherTenant = await prisma.tenant.create({
      data: {
        code: `other-space-${suffix}`,
        name: 'External Tenant',
        securityPolicy: { create: {} },
        groups: { create: { name: `External Group ${suffix}` } },
        users: {
          create: {
            loginName: `external-user-${suffix}`,
            email: `external-user-${suffix}@example.test`,
            displayName: 'External Tenant Employee',
            status: 'ACTIVE',
          },
        },
      },
      include: { groups: true, users: true },
    });
    const externalGroup = otherTenant.groups[0]!;
    const externalUser = otherTenant.users[0]!;

    const actor = authenticatedUser(administrator.id, tenant.id, ['password', 'totp']);
    const companyAActor = authenticatedUser(companyAUser.id, tenant.id);
    const companyBActor = authenticatedUser(companyBUser.id, tenant.id);
    const logisticsActor = authenticatedUser(logisticsUser.id, tenant.id);
    const externalActor = authenticatedUser(externalUser.id, otherTenant.id);
    const metadata = { ipAddress: '127.0.0.1', requestId: randomUUID() };

    const privateA = await spaces.create(
      actor,
      {
        code: `private-a-${suffix}`,
        name: 'Company A Private',
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: companyA.id,
        quotaBytes: '1000000',
      },
      metadata,
    );
    const privateB = await spaces.create(
      actor,
      {
        code: `private-b-${suffix}`,
        name: 'Company B Private',
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: companyB.id,
        quotaBytes: '1000000',
      },
      metadata,
    );
    const groupShared = await spaces.create(
      actor,
      {
        code: `group-shared-${suffix}`,
        name: 'Group Shared Assets',
        ownerType: 'TENANT',
        quotaBytes: '1000000',
      },
      metadata,
    );

    await members.upsert(
      actor,
      privateA.id,
      { principalType: 'ORGANIZATION', principalId: companyA.id },
      { roleCode: 'viewer' },
      metadata,
    );
    await members.upsert(
      actor,
      privateB.id,
      { principalType: 'ORGANIZATION', principalId: companyB.id },
      { roleCode: 'viewer' },
      metadata,
    );
    await members.upsert(
      actor,
      privateA.id,
      { principalType: 'GROUP', principalId: sharedLogisticsGroup.id },
      { roleCode: 'restricted' },
      metadata,
    );
    await members.upsert(
      actor,
      privateB.id,
      { principalType: 'GROUP', principalId: sharedLogisticsGroup.id },
      { roleCode: 'restricted' },
      metadata,
    );
    await members.upsert(
      actor,
      groupShared.id,
      { principalType: 'ORGANIZATION', principalId: companyA.id },
      { roleCode: 'viewer' },
      metadata,
    );
    await members.upsert(
      actor,
      groupShared.id,
      { principalType: 'ORGANIZATION', principalId: companyB.id },
      { roleCode: 'editor' },
      metadata,
    );
    await expect(
      members.upsert(
        actor,
        groupShared.id,
        { principalType: 'GROUP', principalId: externalGroup.id },
        { roleCode: 'viewer' },
        metadata,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const cachedBeforeGroupMembership = await authorization.subject(logisticsActor);
    const previousCacheKey = subjectCacheKey(
      tenant.id,
      cachedBeforeGroupMembership.authorizationVersion,
      logisticsUser.id,
    );
    expect(cache.has(previousCacheKey)).toBe(true);
    expect(cachedBeforeGroupMembership.principals).not.toContainEqual({
      type: 'GROUP',
      id: sharedLogisticsGroup.id,
    });
    expect(await authorization.canEnterSpace(logisticsActor, privateA.id)).toBe(false);

    await groups.addMember(actor, sharedLogisticsGroup.id, logisticsUser.id, metadata);

    const refreshedSubject = await authorization.subject(logisticsActor);
    const refreshedCacheKey = subjectCacheKey(
      tenant.id,
      refreshedSubject.authorizationVersion,
      logisticsUser.id,
    );
    expect(BigInt(refreshedSubject.authorizationVersion)).toBeGreaterThan(
      BigInt(cachedBeforeGroupMembership.authorizationVersion),
    );
    expect(refreshedCacheKey).not.toBe(previousCacheKey);
    expect(cache.has(refreshedCacheKey)).toBe(true);
    expect(refreshedSubject.principals).toContainEqual({
      type: 'GROUP',
      id: sharedLogisticsGroup.id,
    });

    const [privateARoot, privateBRoot, groupSharedRoot] = await Promise.all([
      findRoot(prisma, privateA.id),
      findRoot(prisma, privateB.id),
      findRoot(prisma, groupShared.id),
    ]);
    const [privateALogistics, privateAExecutive] = await Promise.all([
      createChild(prisma, privateA.id, privateARoot.id, administrator.id, 'A Logistics', suffix),
      createChild(prisma, privateA.id, privateARoot.id, administrator.id, 'A Executive', suffix),
    ]);
    const [privateBLogistics, privateBFinance] = await Promise.all([
      createChild(prisma, privateB.id, privateBRoot.id, administrator.id, 'B Logistics', suffix),
      createChild(prisma, privateB.id, privateBRoot.id, administrator.id, 'B Finance', suffix),
    ]);
    const [privateALogisticsFile, privateBLogisticsFile, privateBSensitiveFile, sharedFile] =
      await Promise.all([
        createChild(
          prisma,
          privateA.id,
          privateALogistics.id,
          administrator.id,
          'A Delivery Schedule.pdf',
          suffix,
          'ASSET',
        ),
        createChild(
          prisma,
          privateB.id,
          privateBLogistics.id,
          administrator.id,
          'B Inventory List.xlsx',
          suffix,
          'ASSET',
        ),
        createChild(
          prisma,
          privateB.id,
          privateBLogistics.id,
          administrator.id,
          'B Confidential Quote.pdf',
          suffix,
          'ASSET',
        ),
        createChild(
          prisma,
          groupShared.id,
          groupSharedRoot.id,
          administrator.id,
          'Group Policy.pdf',
          suffix,
          'ASSET',
        ),
      ]);

    expect(await authorization.canEnterSpace(companyAActor, privateA.id)).toBe(true);
    expect(await authorization.canEnterSpace(companyAActor, privateB.id)).toBe(false);
    expect(await authorization.canEnterSpace(companyBActor, privateB.id)).toBe(true);
    expect(await authorization.canEnterSpace(companyBActor, privateA.id)).toBe(false);
    await expect(
      authorization.evaluate(companyAActor, 'node.view', {
        type: 'NODE',
        id: privateARoot.id,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allow', roleCodes: ['viewer'] });
    await expect(
      authorization.evaluate(companyBActor, 'node.view', {
        type: 'NODE',
        id: privateBRoot.id,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allow', roleCodes: ['viewer'] });
    await expect(
      authorization.evaluate(companyBActor, 'node.view', {
        type: 'NODE',
        id: privateARoot.id,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'default_deny' });
    await expect(
      authorization.evaluate(companyAActor, 'node.view', {
        type: 'NODE',
        id: privateBRoot.id,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'default_deny' });

    expect(await authorization.canEnterSpace(logisticsActor, privateA.id)).toBe(true);
    expect(await authorization.canEnterSpace(logisticsActor, privateB.id)).toBe(true);
    await expect(
      authorization.evaluate(logisticsActor, 'node.view', {
        type: 'NODE',
        id: privateAExecutive.id,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'default_deny' });
    await expect(
      authorization.evaluate(logisticsActor, 'node.view', {
        type: 'NODE',
        id: privateBFinance.id,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'default_deny' });

    const privateAAllow = await acl.upsert(
      actor,
      privateALogistics.id,
      {
        principalType: 'GROUP',
        principalId: sharedLogisticsGroup.id,
        permissionCode: 'node.view',
        effect: 'ALLOW',
      },
      metadata,
    );
    const privateBAllow = await acl.upsert(
      actor,
      privateBLogistics.id,
      {
        principalType: 'GROUP',
        principalId: sharedLogisticsGroup.id,
        permissionCode: 'node.view',
        effect: 'ALLOW',
      },
      metadata,
    );
    await expect(
      authorization.evaluate(logisticsActor, 'node.view', {
        type: 'NODE',
        id: privateALogistics.id,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'explicit_allow',
      matchedAclEntryIds: [privateAAllow.id],
    });
    await expect(
      authorization.evaluate(logisticsActor, 'node.view', {
        type: 'NODE',
        id: privateBLogistics.id,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'explicit_allow',
      matchedAclEntryIds: [privateBAllow.id],
    });
    await expect(
      authorization.evaluate(logisticsActor, 'node.view', {
        type: 'NODE',
        id: privateALogisticsFile.id,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'explicit_allow',
      matchedAclEntryIds: [privateAAllow.id],
    });
    await expect(
      authorization.evaluate(logisticsActor, 'node.view', {
        type: 'NODE',
        id: privateBLogisticsFile.id,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'explicit_allow',
      matchedAclEntryIds: [privateBAllow.id],
    });

    const privateBSensitiveDeny = await acl.upsert(
      actor,
      privateBSensitiveFile.id,
      {
        principalType: 'GROUP',
        principalId: sharedLogisticsGroup.id,
        permissionCode: 'node.view',
        effect: 'DENY',
      },
      metadata,
    );
    await expect(
      authorization.evaluate(logisticsActor, 'node.view', {
        type: 'NODE',
        id: privateBSensitiveFile.id,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'explicit_deny',
      matchedAclEntryIds: [privateBSensitiveDeny.id],
    });
    const inheritedAcl = await acl.list(actor, privateBSensitiveFile.id, {
      includeInherited: true,
    });
    expect(inheritedAcl.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: privateBSensitiveDeny.id, depth: 0, inherited: false }),
        expect.objectContaining({ id: privateBAllow.id, depth: 1, inherited: true }),
      ]),
    );

    await expect(
      authorization.evaluate(companyAActor, 'node.view', {
        type: 'NODE',
        id: sharedFile.id,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allow', roleCodes: ['viewer'] });
    await expect(
      authorization.evaluate(companyAActor, 'node.create', {
        type: 'NODE',
        id: groupSharedRoot.id,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'default_deny' });
    await expect(
      authorization.evaluate(companyBActor, 'node.view', {
        type: 'NODE',
        id: sharedFile.id,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allow', roleCodes: ['editor'] });
    await expect(
      authorization.evaluate(companyBActor, 'node.create', {
        type: 'NODE',
        id: groupSharedRoot.id,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allow', roleCodes: ['editor'] });

    expect(await authorization.canEnterSpace(externalActor, privateA.id)).toBe(false);
    await expect(
      authorization.evaluate(externalActor, 'node.view', {
        type: 'NODE',
        id: privateALogisticsFile.id,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    await acl.remove(actor, privateBSensitiveFile.id, privateBSensitiveDeny.id, metadata);
    await expect(
      authorization.evaluate(logisticsActor, 'node.view', {
        type: 'NODE',
        id: privateBSensitiveFile.id,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'explicit_allow' });
    await members.remove(
      actor,
      privateB.id,
      { principalType: 'GROUP', principalId: sharedLogisticsGroup.id },
      metadata,
    );
    expect(await authorization.canEnterSpace(logisticsActor, privateB.id)).toBe(false);
    await expect(
      prisma.resourceAclEntry.count({
        where: {
          principalType: 'GROUP',
          principalId: sharedLogisticsGroup.id,
          resourceNode: { spaceId: privateB.id },
        },
      }),
    ).resolves.toBe(0);
    await expect(
      members.remove(
        actor,
        groupShared.id,
        { principalType: 'USER', principalId: administrator.id },
        metadata,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  }, 30_000);
});

function authenticatedUser(
  userId: string,
  tenantId: string,
  authenticationMethods: AuthenticatedUser['authenticationMethods'] = ['password'],
): AuthenticatedUser {
  return {
    userId,
    tenantId,
    sessionId: randomUUID(),
    authenticationMethods,
  };
}

function createUser(
  prisma: PrismaService,
  tenantId: string,
  loginName: string,
  displayName: string,
) {
  return prisma.user.create({
    data: {
      tenantId,
      loginName,
      email: `${loginName}@example.test`,
      displayName,
      status: 'ACTIVE',
    },
  });
}

function subjectCacheKey(tenantId: string, authorizationVersion: string, userId: string): string {
  return `dam:authorization:subject:${tenantId}:${authorizationVersion}:${userId}`;
}

function findRoot(prisma: PrismaService, spaceId: string) {
  return prisma.resourceNode.findFirstOrThrow({ where: { spaceId, isRoot: true } });
}

async function createChild(
  prisma: PrismaService,
  spaceId: string,
  parentId: string,
  createdById: string,
  name: string,
  suffix: string,
  nodeType: 'FOLDER' | 'ASSET' = 'FOLDER',
) {
  const ancestors = await prisma.resourceClosure.findMany({
    where: { descendantId: parentId },
    select: { ancestorId: true, depth: true },
  });
  const node = await prisma.resourceNode.create({
    data: {
      spaceId,
      parentId,
      nodeType,
      name,
      normalizedName: `${name.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
      createdById,
    },
  });
  await prisma.resourceClosure.createMany({
    data: [
      { ancestorId: node.id, descendantId: node.id, depth: 0 },
      ...ancestors.map(({ ancestorId, depth }) => ({
        ancestorId,
        descendantId: node.id,
        depth: depth + 1,
      })),
    ],
  });
  return node;
}
