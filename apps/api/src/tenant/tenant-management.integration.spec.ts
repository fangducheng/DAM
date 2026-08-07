import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationPolicy } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { PrismaService } from '../infrastructure/prisma.service.js';
import { PrismaService as Database } from '../infrastructure/prisma.service.js';
import type { RedisService } from '../infrastructure/redis.service.js';
import { assertLocalIntegrationRunner } from '../testing/integration-test.guard.js';
import { GroupService } from './group.service.js';
import { OrganizationService } from './organization.service.js';
import { TenantService } from './tenant.service.js';

const integrationEnabled = process.env['DAM_TENANT_INTEGRATION_TESTS'] === '1';
assertLocalIntegrationRunner(integrationEnabled);
const integration = integrationEnabled ? describe : describe.skip;

integration('Tenant, organization, and shared-group management', () => {
  const prisma: PrismaService = new Database();
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
  const tenants = new TenantService(prisma, authorization);
  const organizations = new OrganizationService(prisma, authorization);
  const groups = new GroupService(prisma, authorization);

  let tenantId: string;
  let companyAId: string;
  let actorId: string;
  let sharedUserId: string;
  let outsiderId: string;
  let actor: AuthenticatedUser;

  beforeAll(async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const [platformAdmin, organizationAdmin] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { code: 'platform_admin' } }),
      prisma.role.findUniqueOrThrow({ where: { code: 'organization_admin' } }),
    ]);
    const tenant = await prisma.tenant.create({
      data: {
        code: `tenant-management-${suffix}`,
        name: 'Tenant Management Integration',
        securityPolicy: { create: {} },
      },
    });
    const companyA = await prisma.organization.create({
      data: { tenantId: tenant.id, code: `company-a-${suffix}`, name: 'Company A' },
    });
    const administrator = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `administrator-${suffix}`,
        email: `administrator-${suffix}@example.test`,
        displayName: 'Tenant Administrator',
        status: 'ACTIVE',
      },
    });
    const sharedUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `shared-${suffix}`,
        email: `shared-${suffix}@example.test`,
        displayName: 'Shared Logistics',
        status: 'ACTIVE',
      },
    });
    const otherTenant = await prisma.tenant.create({
      data: {
        code: `other-${suffix}`,
        name: 'Other Tenant',
        securityPolicy: { create: {} },
      },
    });
    const outsider = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        loginName: `outsider-${suffix}`,
        email: `outsider-${suffix}@example.test`,
        displayName: 'Outsider',
        status: 'ACTIVE',
      },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: companyA.id,
        userId: administrator.id,
        isPrimary: true,
      },
    });
    await prisma.roleBinding.createMany({
      data: [
        {
          tenantId: tenant.id,
          roleId: platformAdmin.id,
          principalType: 'USER',
          principalId: administrator.id,
          scopeType: 'TENANT',
          scopeId: tenant.id,
        },
        {
          tenantId: tenant.id,
          roleId: organizationAdmin.id,
          principalType: 'USER',
          principalId: administrator.id,
          scopeType: 'ORGANIZATION',
          scopeId: companyA.id,
        },
      ],
    });

    tenantId = tenant.id;
    companyAId = companyA.id;
    actorId = administrator.id;
    sharedUserId = sharedUser.id;
    outsiderId = outsider.id;
    actor = {
      userId: actorId,
      tenantId,
      sessionId: randomUUID(),
      authenticationMethods: ['password', 'totp'],
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('manages A/B memberships and invalidates shared-group principals by Tenant version', async () => {
    const metadata = { ipAddress: '127.0.0.1', requestId: randomUUID() };
    const initial = await tenants.current(actor);
    const initialVersion = BigInt(initial.authorizationVersion);

    const companyB = await organizations.create(
      actor,
      {
        code: `company-b-${randomUUID().slice(0, 8)}`,
        name: 'Company B',
        parentOrganizationId: companyAId,
      },
      metadata,
    );
    await organizations.upsertMember(
      actor,
      companyAId,
      sharedUserId,
      { roleCode: 'organization_member' },
      metadata,
    );
    await organizations.upsertMember(
      actor,
      companyB.id,
      sharedUserId,
      { roleCode: 'organization_member' },
      metadata,
    );

    const sharedActor: AuthenticatedUser = {
      userId: sharedUserId,
      tenantId,
      sessionId: randomUUID(),
      authenticationMethods: ['password'],
    };
    const beforeGroup = await authorization.subject(sharedActor);
    expect(
      beforeGroup.principals
        .filter((principal) => principal.type === 'ORGANIZATION')
        .map((principal) => principal.id),
    ).toEqual(expect.arrayContaining([companyAId, companyB.id]));
    expect(beforeGroup.principals.some((principal) => principal.type === 'GROUP')).toBe(false);

    const sharedGroup = await groups.create(
      actor,
      { name: `Shared Logistics ${randomUUID().slice(0, 8)}`, type: 'CUSTOM' },
      metadata,
    );
    await groups.addMember(actor, sharedGroup.id, sharedUserId, metadata);
    const withGroup = await authorization.subject(sharedActor);
    expect(BigInt(withGroup.authorizationVersion)).toBeGreaterThan(
      BigInt(beforeGroup.authorizationVersion),
    );
    expect(
      withGroup.principals.some(
        (principal) => principal.type === 'GROUP' && principal.id === sharedGroup.id,
      ),
    ).toBe(true);
    await expect(
      groups.addMember(actor, sharedGroup.id, outsiderId, metadata),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    await groups.update(actor, sharedGroup.id, { status: 'DISABLED' }, metadata);
    const disabledGroup = await authorization.subject(sharedActor);
    expect(BigInt(disabledGroup.authorizationVersion)).toBeGreaterThan(
      BigInt(withGroup.authorizationVersion),
    );
    expect(
      disabledGroup.principals.some(
        (principal) => principal.type === 'GROUP' && principal.id === sharedGroup.id,
      ),
    ).toBe(false);

    await expect(
      organizations.removeMember(actor, companyAId, actorId, metadata),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const finalTenant = await tenants.current(actor);
    expect(BigInt(finalTenant.authorizationVersion)).toBeGreaterThan(initialVersion);
    await expect(
      prisma.auditEvent.count({
        where: {
          tenantId,
          action: {
            in: [
              'organization.create',
              'organization.membership.upsert',
              'group.create',
              'group.member.add',
              'group.update',
            ],
          },
          result: 'SUCCEEDED',
        },
      }),
    ).resolves.toBe(6);
  });
});
