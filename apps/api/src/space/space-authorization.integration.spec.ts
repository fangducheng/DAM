import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationPolicy } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { RedisService } from '../infrastructure/redis.service.js';
import { AclService } from './acl.service.js';
import { SpaceMemberService } from './space-member.service.js';
import { SpaceService } from './space.service.js';

const integrationEnabled = process.env['DAM_SPACE_INTEGRATION_TESTS'] === '1';
const integration = integrationEnabled ? describe : describe.skip;

integration('A/B private spaces, shared groups, and inherited ACL', () => {
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

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('isolates private spaces and applies inherited ALLOW with direct DENY precedence', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const platformAdmin = await prisma.role.findUniqueOrThrow({
      where: { code: 'platform_admin' },
    });
    const tenant = await prisma.tenant.create({
      data: {
        code: `space-auth-${suffix}`,
        name: 'Space Authorization Integration',
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
    const [administrator, companyAUser, sharedUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          loginName: `space-admin-${suffix}`,
          email: `space-admin-${suffix}@example.test`,
          displayName: 'Space Administrator',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          loginName: `company-a-user-${suffix}`,
          email: `company-a-user-${suffix}@example.test`,
          displayName: 'Company A User',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          loginName: `shared-user-${suffix}`,
          email: `shared-user-${suffix}@example.test`,
          displayName: 'Shared Logistics User',
          status: 'ACTIVE',
        },
      }),
    ]);
    await prisma.organizationMembership.create({
      data: { organizationId: companyA.id, userId: companyAUser.id, isPrimary: true },
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
    const sharedGroup = await prisma.group.create({
      data: {
        tenantId: tenant.id,
        name: `Shared Logistics ${suffix}`,
        type: 'DEPARTMENT',
        members: { create: { userId: sharedUser.id } },
      },
    });
    const otherTenant = await prisma.tenant.create({
      data: {
        code: `other-space-${suffix}`,
        name: 'Other Space Tenant',
        securityPolicy: { create: {} },
        groups: { create: { name: `Outsider Group ${suffix}` } },
      },
      include: { groups: true },
    });
    const outsiderGroup = otherTenant.groups[0]!;

    const actor: AuthenticatedUser = {
      userId: administrator.id,
      tenantId: tenant.id,
      sessionId: randomUUID(),
      authenticationMethods: ['password', 'totp'],
    };
    const companyActor: AuthenticatedUser = {
      userId: companyAUser.id,
      tenantId: tenant.id,
      sessionId: randomUUID(),
      authenticationMethods: ['password'],
    };
    const sharedActor: AuthenticatedUser = {
      userId: sharedUser.id,
      tenantId: tenant.id,
      sessionId: randomUUID(),
      authenticationMethods: ['password'],
    };
    const metadata = { ipAddress: '127.0.0.1', requestId: randomUUID() };
    const [privateA, privateB, shared] = await Promise.all([
      spaces.create(
        actor,
        {
          code: `private-a-${suffix}`,
          name: 'Company A Private',
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: companyA.id,
          quotaBytes: '1000000',
        },
        metadata,
      ),
      spaces.create(
        actor,
        {
          code: `private-b-${suffix}`,
          name: 'Company B Private',
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: companyB.id,
          quotaBytes: '1000000',
        },
        metadata,
      ),
      spaces.create(
        actor,
        {
          code: `shared-${suffix}`,
          name: 'Group Shared Services',
          ownerType: 'TENANT',
          quotaBytes: '1000000',
        },
        metadata,
      ),
    ]);
    await members.upsert(
      actor,
      privateA.id,
      { principalType: 'ORGANIZATION', principalId: companyA.id },
      { roleCode: 'viewer' },
      metadata,
    );
    await members.upsert(
      actor,
      shared.id,
      { principalType: 'GROUP', principalId: sharedGroup.id },
      { roleCode: 'restricted' },
      metadata,
    );
    await expect(
      members.upsert(
        actor,
        shared.id,
        { principalType: 'GROUP', principalId: outsiderGroup.id },
        { roleCode: 'viewer' },
        metadata,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const [privateARoot, , sharedRoot] = await Promise.all([
      createRoot(prisma, privateA.id, administrator.id, `A Root ${suffix}`),
      createRoot(prisma, privateB.id, administrator.id, `B Root ${suffix}`),
      createRoot(prisma, shared.id, administrator.id, `Shared Root ${suffix}`),
    ]);
    const folder = await prisma.resourceNode.create({
      data: {
        spaceId: shared.id,
        parentId: sharedRoot.id,
        nodeType: 'FOLDER',
        name: 'Contracts',
        normalizedName: `contracts-${suffix}`,
        createdById: administrator.id,
      },
    });
    const file = await prisma.resourceNode.create({
      data: {
        spaceId: shared.id,
        parentId: folder.id,
        nodeType: 'ASSET',
        name: 'Shared Contract.pdf',
        normalizedName: `shared-contract-${suffix}.pdf`,
        createdById: administrator.id,
      },
    });
    await prisma.resourceClosure.createMany({
      data: [
        { ancestorId: folder.id, descendantId: folder.id, depth: 0 },
        { ancestorId: sharedRoot.id, descendantId: folder.id, depth: 1 },
        { ancestorId: file.id, descendantId: file.id, depth: 0 },
        { ancestorId: folder.id, descendantId: file.id, depth: 1 },
        { ancestorId: sharedRoot.id, descendantId: file.id, depth: 2 },
      ],
    });

    expect(await authorization.canEnterSpace(companyActor, privateA.id)).toBe(true);
    expect(await authorization.canEnterSpace(companyActor, privateB.id)).toBe(false);
    await expect(
      authorization.evaluate(companyActor, 'node.view', { type: 'NODE', id: privateARoot.id }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allow' });
    expect(await authorization.canEnterSpace(sharedActor, privateA.id)).toBe(false);
    expect(await authorization.canEnterSpace(sharedActor, shared.id)).toBe(true);
    await expect(
      authorization.evaluate(sharedActor, 'node.view', { type: 'NODE', id: file.id }),
    ).resolves.toMatchObject({ allowed: false, reason: 'default_deny' });

    const inheritedAllow = await acl.upsert(
      actor,
      folder.id,
      {
        principalType: 'GROUP',
        principalId: sharedGroup.id,
        permissionCode: 'node.view',
        effect: 'ALLOW',
      },
      metadata,
    );
    await expect(
      authorization.evaluate(sharedActor, 'node.view', { type: 'NODE', id: file.id }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'explicit_allow',
      matchedAclEntryIds: [inheritedAllow.id],
    });
    const directDeny = await acl.upsert(
      actor,
      file.id,
      {
        principalType: 'GROUP',
        principalId: sharedGroup.id,
        permissionCode: 'node.view',
        effect: 'DENY',
      },
      metadata,
    );
    await expect(
      authorization.evaluate(sharedActor, 'node.view', { type: 'NODE', id: file.id }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'explicit_deny',
      matchedAclEntryIds: [directDeny.id],
    });
    const aclList = await acl.list(actor, file.id, { includeInherited: true });
    expect(aclList.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: directDeny.id, depth: 0, inherited: false }),
        expect.objectContaining({ id: inheritedAllow.id, depth: 1, inherited: true }),
      ]),
    );

    await acl.remove(actor, file.id, directDeny.id, metadata);
    await expect(
      authorization.evaluate(sharedActor, 'node.view', { type: 'NODE', id: file.id }),
    ).resolves.toMatchObject({ allowed: true, reason: 'explicit_allow' });
    await members.remove(
      actor,
      shared.id,
      { principalType: 'GROUP', principalId: sharedGroup.id },
      metadata,
    );
    expect(await authorization.canEnterSpace(sharedActor, shared.id)).toBe(false);
    await expect(
      prisma.resourceAclEntry.count({
        where: { principalType: 'GROUP', principalId: sharedGroup.id },
      }),
    ).resolves.toBe(0);
    await expect(
      members.remove(
        actor,
        shared.id,
        { principalType: 'USER', principalId: administrator.id },
        metadata,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

async function createRoot(
  prisma: PrismaService,
  spaceId: string,
  createdById: string,
  name: string,
) {
  const root = await prisma.resourceNode.create({
    data: {
      spaceId,
      nodeType: 'FOLDER',
      name,
      normalizedName: name.toLowerCase().replaceAll(' ', '-'),
      createdById,
    },
  });
  await prisma.resourceClosure.create({
    data: { ancestorId: root.id, descendantId: root.id, depth: 0 },
  });
  return root;
}
