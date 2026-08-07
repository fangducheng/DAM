import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generate } from 'otplib';
import { beforeAll, describe, expect, it } from 'vitest';

import { validateEnvironment } from '@dam/config';

import { AuthorizationPolicy } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { RedisService } from '../infrastructure/redis.service.js';
import { IdentityService } from './identity.service.js';
import { InvitationService } from './invitation.service.js';
import { IdentityTokenService } from './security/identity-token.service.js';
import { PasswordService } from './security/password.service.js';
import { SecurityCryptoService } from './security/security-crypto.service.js';
import { TotpService } from './security/totp.service.js';
import { SessionService } from './session.service.js';

const integrationEnabled = process.env['DAM_IDENTITY_INTEGRATION_TESTS'] === '1';
const integration = integrationEnabled ? describe : describe.skip;

if (integrationEnabled) {
  const rootEnvPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(rootEnvPath)) {
    process.loadEnvFile(rootEnvPath);
  }
}

integration('identity lifecycle integration', () => {
  const prisma = new PrismaService();
  const config = new ConfigService(validateEnvironment(process.env));
  const passwords = new PasswordService(config);
  const crypto = new SecurityCryptoService(config);
  const totp = new TotpService(config);
  const tokenService = new IdentityTokenService(new JwtService(), config);
  const sessions = new SessionService(prisma, crypto, tokenService, config);
  const identity = new IdentityService(prisma, passwords, crypto, totp, tokenService, sessions);
  const authorizationCache = new Map<string, unknown>();
  const redis = {
    getJson<T>(key: string): Promise<T | null> {
      return Promise.resolve((authorizationCache.get(key) as T | undefined) ?? null);
    },
    setJson(key: string, value: unknown): Promise<void> {
      authorizationCache.set(key, value);
      return Promise.resolve();
    },
  } as unknown as RedisService;
  const authorization = new AuthorizationService(prisma, redis, new AuthorizationPolicy(), config);
  const invitations = new InvitationService(prisma, passwords, crypto, totp, authorization);

  let tenantId: string;
  let organizationId: string;
  let actorId: string;

  beforeAll(async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const platformAdmin = await prisma.role.findUniqueOrThrow({
      where: { code: 'platform_admin' },
    });
    const tenant = await prisma.tenant.create({
      data: {
        code: `identity-${suffix}`,
        name: 'Identity Integration Tenant',
        securityPolicy: { create: {} },
      },
    });
    const organization = await prisma.organization.create({
      data: { tenantId: tenant.id, code: `org-${suffix}`, name: 'Identity Integration Org' },
    });
    const actor = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `owner-${suffix}`,
        email: `owner-${suffix}@example.test`,
        displayName: 'Integration Owner',
        status: 'ACTIVE',
        credential: { create: { passwordHash: await passwords.hash('owner password 12345') } },
      },
    });
    await prisma.roleBinding.create({
      data: {
        tenantId: tenant.id,
        roleId: platformAdmin.id,
        principalType: 'USER',
        principalId: actor.id,
        scopeType: 'TENANT',
        scopeId: tenant.id,
      },
    });

    tenantId = tenant.id;
    organizationId = organization.id;
    actorId = actor.id;
  });

  it('returns effective Tenant capabilities in the shared permission order', async () => {
    const capabilities = await authorization.tenantCapabilities({
      userId: actorId,
      tenantId,
      sessionId: randomUUID(),
      authenticationMethods: ['password', 'totp'],
    });

    expect(capabilities.authorizationVersion).toBeTruthy();
    expect(capabilities.permissions).toContain('maintenance.read');
    expect(capabilities.permissions).toContain('maintenance.manage');
  });

  it('accepts an admin invitation and revokes the token family on refresh replay', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const actor = {
      userId: actorId,
      tenantId,
      sessionId: randomUUID(),
      authenticationMethods: ['password', 'totp'] as const,
    };
    const created = await invitations.create(
      actor,
      {
        type: 'ORGANIZATION_MEMBER',
        organizationId,
        email: `admin-${suffix}@example.test`,
        loginName: `admin-${suffix}`,
        displayName: 'Invited Administrator',
        initialRoleCode: 'organization_admin',
      },
      { ipAddress: '127.0.0.1', requestId: `invite-${suffix}` },
    );
    const storedInvitation = await prisma.invitation.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(storedInvitation.tokenHash).not.toBe(created.token);

    const acceptance = await invitations.accept(created.token, 'invited password 12345');
    expect(acceptance).toMatchObject({ accepted: false, mfaVerificationRequired: true });
    expect(acceptance.provisioningUri).toContain('otpauth://totp/');

    const invitedUser = await prisma.user.findUniqueOrThrow({
      where: { tenantId_email: { tenantId, email: `admin-${suffix}@example.test` } },
      include: { mfaMethods: true },
    });
    const mfaMethod = invitedUser.mfaMethods[0];
    expect(mfaMethod).toBeDefined();
    const secret = crypto.decryptSecret(mfaMethod!.secretCiphertext);
    const code = await generate({ secret });
    const confirmed = await invitations.confirmMfa(created.token, code);
    expect(confirmed.recoveryCodes).toHaveLength(10);

    const login = await identity.login(
      {
        tenantCode: (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).code,
        identifier: `admin-${suffix}`,
        password: 'invited password 12345',
      },
      { ipAddress: '127.0.0.1', requestId: `login-${suffix}` },
    );
    expect('mfaRequired' in login).toBe(true);
    if (!('mfaRequired' in login)) {
      throw new Error('Expected MFA challenge');
    }

    const issued = await identity.completeMfa(login.challengeToken, confirmed.recoveryCodes[0]!, {
      ipAddress: '127.0.0.1',
      requestId: `mfa-${suffix}`,
    });
    expect(issued.user.authenticationMethods).toEqual(['password', 'recovery_code']);

    const rotated = await identity.refresh(issued.refreshToken, {
      ipAddress: '127.0.0.2',
      requestId: `refresh-${suffix}`,
    });
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);

    await expect(
      identity.refresh(issued.refreshToken, {
        ipAddress: '127.0.0.3',
        requestId: `replay-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(
      identity.refresh(rotated.refreshToken, {
        ipAddress: '127.0.0.4',
        requestId: `revoked-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(
      prisma.auditEvent.count({
        where: {
          tenantId,
          actorUserId: invitedUser.id,
          action: 'identity.refresh.replay',
          result: 'DENIED',
        },
      }),
    ).resolves.toBe(1);
  });
});
