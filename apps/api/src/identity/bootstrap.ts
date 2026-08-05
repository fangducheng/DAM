import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { validateEnvironment } from '@dam/config';
import { PrismaClient } from '@dam/database';

const rootEnvPath = resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const environment = validateEnvironment(process.env);
const prisma = new PrismaClient();

function input(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function tokenHash(token: string): string {
  return createHmac('sha256', environment.TOKEN_HASH_SECRET).update(token).digest('hex');
}

async function bootstrapIdentity(): Promise<void> {
  const tenantCode = input('BOOTSTRAP_TENANT_CODE', 'dam-local').toLowerCase();
  const tenantName = input('BOOTSTRAP_TENANT_NAME', 'DAM Local Tenant');
  const organizationCode = input('BOOTSTRAP_ORGANIZATION_CODE', 'company-a').toLowerCase();
  const organizationName = input('BOOTSTRAP_ORGANIZATION_NAME', 'Company A');
  const email = input('BOOTSTRAP_ADMIN_EMAIL', 'admin@dam.local').toLowerCase();
  const loginName = input('BOOTSTRAP_ADMIN_LOGIN', 'admin').toLowerCase();
  const displayName = input('BOOTSTRAP_ADMIN_DISPLAY_NAME', 'Local Administrator');
  const invitationToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);

  const result = await prisma.$transaction(async (database) => {
    const platformAdmin = await database.role.findUnique({
      where: { code: 'platform_admin' },
      select: { id: true },
    });
    const organizationAdmin = await database.role.findUnique({
      where: { code: 'organization_admin' },
      select: { id: true },
    });
    if (platformAdmin === null || organizationAdmin === null) {
      throw new Error('System roles are missing. Run pnpm --filter @dam/database seed first.');
    }

    const tenant = await database.tenant.upsert({
      where: { code: tenantCode },
      update: { name: tenantName },
      create: {
        code: tenantCode,
        name: tenantName,
        securityPolicy: { create: {} },
      },
      select: { id: true, status: true },
    });
    if (tenant.status !== 'ACTIVE') {
      throw new Error(`Tenant ${tenantCode} is not active.`);
    }
    await database.tenantSecurityPolicy.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: { tenantId: tenant.id },
    });

    const organization = await database.organization.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: organizationCode } },
      update: { name: organizationName },
      create: { tenantId: tenant.id, code: organizationCode, name: organizationName },
      select: { id: true, status: true },
    });
    if (organization.status !== 'ACTIVE') {
      throw new Error(`Organization ${organizationCode} is not active.`);
    }

    const user = await database.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email } },
      update: { loginName, displayName },
      create: { tenantId: tenant.id, loginName, email, displayName, status: 'INVITED' },
      select: { id: true, status: true },
    });
    await database.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
      update: { status: 'ACTIVE', isPrimary: true },
      create: {
        organizationId: organization.id,
        userId: user.id,
        status: 'ACTIVE',
        isPrimary: true,
      },
    });
    await database.roleBinding.createMany({
      data: [
        {
          tenantId: tenant.id,
          roleId: platformAdmin.id,
          principalType: 'USER',
          principalId: user.id,
          scopeType: 'TENANT',
          scopeId: tenant.id,
        },
        {
          tenantId: tenant.id,
          roleId: organizationAdmin.id,
          principalType: 'USER',
          principalId: user.id,
          scopeType: 'ORGANIZATION',
          scopeId: organization.id,
        },
      ],
      skipDuplicates: true,
    });

    if (user.status === 'ACTIVE') {
      return { tenantCode, organizationCode, email, alreadyActive: true as const };
    }

    await database.invitation.updateMany({
      where: {
        tenantId: tenant.id,
        type: 'TENANT_ADMIN',
        email,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    const invitation = await database.invitation.create({
      data: {
        tenantId: tenant.id,
        initialRoleId: platformAdmin.id,
        invitedById: user.id,
        type: 'TENANT_ADMIN',
        email,
        loginName,
        displayName,
        tokenHash: tokenHash(invitationToken),
        expiresAt,
      },
      select: { id: true },
    });
    await database.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'identity.bootstrap',
        resourceType: 'INVITATION',
        resourceId: invitation.id,
        result: 'SUCCEEDED',
      },
    });

    return {
      tenantCode,
      organizationCode,
      email,
      alreadyActive: false as const,
      invitationId: invitation.id,
      expiresAt: expiresAt.toISOString(),
      invitationUrl: `${environment.WEB_ORIGIN}/invitations/accept?token=${encodeURIComponent(invitationToken)}`,
    };
  });

  console.log(JSON.stringify(result, null, 2));
}

try {
  await bootstrapIdentity();
} finally {
  await prisma.$disconnect();
}
