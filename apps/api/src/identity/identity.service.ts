import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';

import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type {
  IdentityRequestMetadata,
  IssuedSession,
  MfaChallenge,
  SessionPolicy,
  SessionSummary,
} from './identity.types.js';
import { PasswordService } from './security/password.service.js';
import { SecurityCryptoService } from './security/security-crypto.service.js';
import { IdentityTokenService } from './security/identity-token.service.js';
import { TotpService } from './security/totp.service.js';
import { SessionService } from './session.service.js';

interface LoginInput {
  tenantCode: string;
  identifier: string;
  password: string;
}

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly crypto: SecurityCryptoService,
    private readonly totp: TotpService,
    private readonly tokens: IdentityTokenService,
    private readonly sessions: SessionService,
  ) {}

  async login(
    input: LoginInput,
    metadata: IdentityRequestMetadata,
  ): Promise<IssuedSession | MfaChallenge> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { code: input.tenantCode },
      select: { id: true, status: true, securityPolicy: true },
    });
    const user =
      tenant === null
        ? null
        : await this.prisma.user.findFirst({
            where: {
              tenantId: tenant.id,
              OR: [{ loginName: input.identifier }, { email: input.identifier }],
            },
            select: {
              id: true,
              tenantId: true,
              status: true,
              credential: true,
            },
          });

    if (
      tenant === null ||
      tenant.status !== 'ACTIVE' ||
      user === null ||
      user.status !== 'ACTIVE' ||
      user.credential === null
    ) {
      await this.audit(tenant?.id, user?.id, 'identity.login', 'FAILED', metadata);
      throw this.invalidCredentials();
    }

    const policy = tenant.securityPolicy ?? this.defaultSecurityPolicy();
    const now = new Date();
    if (user.credential.lockedUntil !== null && user.credential.lockedUntil > now) {
      await this.audit(tenant.id, user.id, 'identity.login', 'LOCKED', metadata);
      throw this.tooManyAttempts();
    }

    if (!(await this.passwords.verify(user.credential.passwordHash, input.password))) {
      const locked = await this.recordPasswordFailure(
        user.id,
        user.credential.failedAttempts,
        user.credential.lockedUntil,
        policy.maxPasswordAttempts,
        policy.passwordLockMinutes,
      );
      await this.audit(
        tenant.id,
        user.id,
        'identity.login',
        locked ? 'LOCKED' : 'FAILED',
        metadata,
      );
      throw locked ? this.tooManyAttempts() : this.invalidCredentials();
    }

    await this.prisma.userCredential.update({
      where: { userId: user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });

    const requireMfa = policy.requireMemberMfa || (await this.hasAdministrativeRole(user.id));
    if (requireMfa) {
      const verifiedMethod = await this.prisma.mfaMethod.findFirst({
        where: { userId: user.id, type: 'TOTP', verifiedAt: { not: null } },
        select: { id: true },
      });
      if (verifiedMethod === null) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          'MFA_REQUIRED',
          '管理员需要先完成多因素认证设置',
        );
      }
    }

    const result = await this.sessions.start(
      user,
      this.sessionPolicy(policy),
      requireMfa,
      metadata,
    );
    await this.audit(
      tenant.id,
      user.id,
      requireMfa ? 'identity.login.password_verified' : 'identity.login',
      'SUCCEEDED',
      metadata,
    );
    return result;
  }

  async completeMfa(
    challengeToken: string,
    code: string,
    metadata: IdentityRequestMetadata,
  ): Promise<IssuedSession> {
    let claims;
    try {
      claims = await this.tokens.verifyMfaChallenge(challengeToken);
    } catch {
      throw this.sessionExpired();
    }

    const session = await this.prisma.authSession.findUnique({
      where: { id: claims.sessionId },
      select: {
        id: true,
        userId: true,
        authenticatedAt: true,
        revokedAt: true,
        expiresAt: true,
        mfaFailedAttempts: true,
        mfaLockedUntil: true,
        user: {
          select: {
            tenantId: true,
            status: true,
            tenant: { select: { securityPolicy: true } },
            mfaMethods: {
              where: { type: 'TOTP', verifiedAt: { not: null } },
              take: 1,
              select: {
                id: true,
                secretCiphertext: true,
                lastUsedTimeStep: true,
                recoveryCodes: {
                  where: { usedAt: null },
                  select: { id: true, codeHash: true },
                },
              },
            },
          },
        },
      },
    });
    const now = new Date();
    if (
      session === null ||
      session.userId !== claims.sub ||
      session.user.tenantId !== claims.tenantId ||
      session.user.status !== 'ACTIVE' ||
      session.authenticatedAt !== null ||
      session.revokedAt !== null ||
      session.expiresAt <= now
    ) {
      throw this.sessionExpired();
    }

    const policy = session.user.tenant.securityPolicy ?? this.defaultSecurityPolicy();
    if (session.mfaLockedUntil !== null && session.mfaLockedUntil > now) {
      throw this.tooManyAttempts();
    }

    const method = session.user.mfaMethods[0];
    if (method === undefined) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'MFA_REQUIRED', '未配置多因素认证');
    }

    const usedMethod = /^\d{6}$/.test(code)
      ? await this.verifyTotp(method, code)
      : await this.verifyRecoveryCode(method.recoveryCodes, code);

    if (usedMethod === null) {
      const locked = await this.recordMfaFailure(
        session.id,
        session.mfaFailedAttempts,
        policy.maxMfaAttempts,
        policy.mfaLockMinutes,
      );
      await this.audit(
        session.user.tenantId,
        session.userId,
        'identity.login.mfa',
        locked ? 'LOCKED' : 'FAILED',
        metadata,
      );
      if (locked) {
        throw this.tooManyAttempts();
      }
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'MFA_INVALID', '验证码或恢复码不正确');
    }

    const issued = await this.sessions.completeMfa(
      { id: session.userId, tenantId: session.user.tenantId },
      session.id,
      usedMethod,
      this.sessionPolicy(policy),
    );
    await this.audit(
      session.user.tenantId,
      session.userId,
      'identity.login.mfa',
      'SUCCEEDED',
      metadata,
    );
    return issued;
  }

  refresh(refreshToken: string, metadata: IdentityRequestMetadata): Promise<IssuedSession> {
    return this.sessions.rotate(refreshToken, metadata);
  }

  async logout(user: AuthenticatedUser, metadata: IdentityRequestMetadata): Promise<void> {
    await this.sessions.revoke(user.userId, user.sessionId, 'LOGOUT');
    await this.audit(user.tenantId, user.userId, 'identity.logout', 'SUCCEEDED', metadata);
  }

  listSessions(user: AuthenticatedUser): Promise<SessionSummary[]> {
    return this.sessions.list(user.userId, user.sessionId);
  }

  async revokeSession(
    user: AuthenticatedUser,
    sessionId: string,
    metadata: IdentityRequestMetadata,
  ): Promise<void> {
    await this.sessions.revoke(user.userId, sessionId);
    await this.audit(user.tenantId, user.userId, 'identity.session.revoke', 'SUCCEEDED', metadata);
  }

  async revokeAllSessions(
    user: AuthenticatedUser,
    metadata: IdentityRequestMetadata,
  ): Promise<number> {
    const count = await this.sessions.revokeAll(user.userId);
    await this.audit(
      user.tenantId,
      user.userId,
      'identity.session.revoke_all',
      'SUCCEEDED',
      metadata,
    );
    return count;
  }

  private async verifyTotp(
    method: { id: string; secretCiphertext: string; lastUsedTimeStep: bigint | null },
    code: string,
  ): Promise<'totp' | null> {
    const secret = this.crypto.decryptSecret(method.secretCiphertext);
    const timeStep = await this.totp.verifyCode(secret, code, method.lastUsedTimeStep);
    if (timeStep === null) {
      return null;
    }

    const updated = await this.prisma.mfaMethod.updateMany({
      where: {
        id: method.id,
        OR: [{ lastUsedTimeStep: null }, { lastUsedTimeStep: { lt: timeStep } }],
      },
      data: { lastUsedTimeStep: timeStep },
    });
    return updated.count === 1 ? 'totp' : null;
  }

  private async verifyRecoveryCode(
    recoveryCodes: Array<{ id: string; codeHash: string }>,
    code: string,
  ): Promise<'recovery_code' | null> {
    const codeHash = this.crypto.hashRecoveryCode(code);
    const recoveryCode = recoveryCodes.find((candidate) => candidate.codeHash === codeHash);
    if (recoveryCode === undefined) {
      return null;
    }

    const used = await this.prisma.mfaRecoveryCode.updateMany({
      where: { id: recoveryCode.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return used.count === 1 ? 'recovery_code' : null;
  }

  private async recordPasswordFailure(
    userId: string,
    currentAttempts: number,
    lockedUntil: Date | null,
    maximumAttempts: number,
    lockMinutes: number,
  ): Promise<boolean> {
    const attempts = lockedUntil !== null && lockedUntil <= new Date() ? 1 : currentAttempts + 1;
    const locked = attempts >= maximumAttempts;
    await this.prisma.userCredential.update({
      where: { userId },
      data: {
        failedAttempts: attempts,
        lockedUntil: locked ? new Date(Date.now() + lockMinutes * 60_000) : null,
      },
    });
    return locked;
  }

  private async recordMfaFailure(
    sessionId: string,
    currentAttempts: number,
    maximumAttempts: number,
    lockMinutes: number,
  ): Promise<boolean> {
    const attempts = currentAttempts + 1;
    const locked = attempts >= maximumAttempts;
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, authenticatedAt: null, revokedAt: null },
      data: {
        mfaFailedAttempts: attempts,
        mfaLockedUntil: locked ? new Date(Date.now() + lockMinutes * 60_000) : null,
      },
    });
    return locked;
  }

  private hasAdministrativeRole(userId: string): Promise<boolean> {
    return this.prisma.roleBinding
      .findFirst({
        where: {
          principalType: 'USER',
          principalId: userId,
          role: { code: { in: ['platform_admin', 'organization_admin'] } },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      })
      .then((binding) => binding !== null);
  }

  private sessionPolicy(policy: {
    accessTokenTtlMinutes: number;
    refreshTokenTtlDays: number;
  }): SessionPolicy {
    return {
      accessTokenTtlMinutes: policy.accessTokenTtlMinutes,
      refreshTokenTtlDays: policy.refreshTokenTtlDays,
    };
  }

  private defaultSecurityPolicy(): {
    requireMemberMfa: boolean;
    accessTokenTtlMinutes: number;
    refreshTokenTtlDays: number;
    maxPasswordAttempts: number;
    passwordLockMinutes: number;
    maxMfaAttempts: number;
    mfaLockMinutes: number;
  } {
    return {
      requireMemberMfa: false,
      accessTokenTtlMinutes: 15,
      refreshTokenTtlDays: 30,
      maxPasswordAttempts: 5,
      passwordLockMinutes: 15,
      maxMfaAttempts: 5,
      mfaLockMinutes: 15,
    };
  }

  private async audit(
    tenantId: string | undefined,
    actorUserId: string | undefined,
    action: string,
    result: string,
    metadata: IdentityRequestMetadata,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: tenantId ?? null,
        actorUserId: actorUserId ?? null,
        action,
        resourceType: actorUserId === undefined ? null : 'USER',
        resourceId: actorUserId ?? null,
        result,
        ipAddress: metadata.ipAddress ?? null,
        userAgent: metadata.userAgent ?? null,
        requestId: metadata.requestId ?? null,
      },
    });
  }

  private invalidCredentials(): ApiException {
    return new ApiException(
      HttpStatus.UNAUTHORIZED,
      'AUTHENTICATION_FAILED',
      '租户、账号或密码不正确',
    );
  }

  private tooManyAttempts(): ApiException {
    return new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      'TOO_MANY_ATTEMPTS',
      '尝试次数过多，请稍后再试',
    );
  }

  private sessionExpired(): ApiException {
    return new ApiException(
      HttpStatus.UNAUTHORIZED,
      'SESSION_EXPIRED',
      '登录状态已失效，请重新登录',
    );
  }
}
