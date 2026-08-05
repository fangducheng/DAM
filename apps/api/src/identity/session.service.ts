import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
import { IdentityTokenService } from './security/identity-token.service.js';
import { SecurityCryptoService } from './security/security-crypto.service.js';

type MfaAuthenticationMethod = 'totp' | 'recovery_code';

interface SessionUser {
  id: string;
  tenantId: string;
}

class RefreshReplayDetected extends Error {
  constructor(readonly tokenFamilyId: string) {
    super('Refresh token replay detected');
  }
}

@Injectable()
export class SessionService {
  private readonly challengeTtlMinutes: number;
  private readonly defaultPolicy: SessionPolicy;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecurityCryptoService,
    private readonly tokens: IdentityTokenService,
    config: ConfigService,
  ) {
    this.challengeTtlMinutes = config.getOrThrow<number>('MFA_CHALLENGE_TTL_MINUTES');
    this.defaultPolicy = {
      accessTokenTtlMinutes: config.getOrThrow<number>('ACCESS_TOKEN_TTL_MINUTES'),
      refreshTokenTtlDays: config.getOrThrow<number>('REFRESH_TOKEN_TTL_DAYS'),
    };
  }

  async start(
    user: SessionUser,
    policy: SessionPolicy,
    requireMfa: boolean,
    metadata: IdentityRequestMetadata,
  ): Promise<IssuedSession | MfaChallenge> {
    const refreshToken = this.crypto.randomToken(48);
    const now = new Date();
    const session = await this.prisma.authSession.create({
      data: {
        userId: user.id,
        tokenFamilyId: randomUUID(),
        refreshTokenHash: this.crypto.hashToken(refreshToken),
        ipAddress: metadata.ipAddress ?? null,
        userAgent: metadata.userAgent ?? null,
        authenticatedAt: requireMfa ? null : now,
        expiresAt: requireMfa
          ? this.addMinutes(now, this.challengeTtlMinutes)
          : this.addDays(now, policy.refreshTokenTtlDays),
      },
    });

    if (requireMfa) {
      return {
        mfaRequired: true,
        challengeToken: await this.tokens.signMfaChallenge(user.id, user.tenantId, session.id),
        expiresInSeconds: this.challengeTtlMinutes * 60,
      };
    }

    return this.issue(user, session.id, null, refreshToken, policy);
  }

  async completeMfa(
    user: SessionUser,
    sessionId: string,
    method: MfaAuthenticationMethod,
    policy: SessionPolicy,
  ): Promise<IssuedSession> {
    const refreshToken = this.crypto.randomToken(48);
    const now = new Date();
    const updated = await this.prisma.authSession.updateMany({
      where: {
        id: sessionId,
        userId: user.id,
        revokedAt: null,
        mfaVerifiedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        refreshTokenHash: this.crypto.hashToken(refreshToken),
        authenticatedAt: now,
        mfaVerifiedAt: now,
        mfaMethod: method,
        mfaFailedAttempts: 0,
        mfaLockedUntil: null,
        lastUsedAt: now,
        expiresAt: this.addDays(now, policy.refreshTokenTtlDays),
      },
    });

    if (updated.count !== 1) {
      throw this.sessionExpired();
    }

    return this.issue(user, sessionId, method, refreshToken, policy);
  }

  async rotate(refreshToken: string, metadata: IdentityRequestMetadata): Promise<IssuedSession> {
    const tokenHash = this.crypto.hashToken(refreshToken);
    const existing = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: tokenHash },
      select: {
        id: true,
        userId: true,
        tokenFamilyId: true,
        mfaMethod: true,
        authenticatedAt: true,
        mfaVerifiedAt: true,
        expiresAt: true,
        revokedAt: true,
        revokedReason: true,
        replacedById: true,
        user: {
          select: {
            tenantId: true,
            status: true,
            tenant: { select: { securityPolicy: true } },
          },
        },
      },
    });

    if (existing === null) {
      throw this.sessionExpired();
    }

    if (existing.replacedById !== null || existing.revokedReason === 'ROTATED') {
      await this.revokeFamily(existing.tokenFamilyId, 'REFRESH_TOKEN_REPLAY');
      await this.auditReplay(
        existing.user.tenantId,
        existing.userId,
        existing.tokenFamilyId,
        metadata,
      );
      throw this.sessionExpired();
    }

    if (
      existing.revokedAt !== null ||
      existing.authenticatedAt === null ||
      existing.expiresAt <= new Date() ||
      existing.user.status !== 'ACTIVE'
    ) {
      throw this.sessionExpired();
    }

    const policy = existing.user.tenant.securityPolicy ?? this.defaultPolicy;
    const nextRefreshToken = this.crypto.randomToken(48);
    const now = new Date();

    try {
      const next = await this.prisma.$transaction(async (database) => {
        const created = await database.authSession.create({
          data: {
            userId: existing.userId,
            tokenFamilyId: existing.tokenFamilyId,
            refreshTokenHash: this.crypto.hashToken(nextRefreshToken),
            ipAddress: metadata.ipAddress ?? null,
            userAgent: metadata.userAgent ?? null,
            authenticatedAt: existing.authenticatedAt,
            mfaVerifiedAt: existing.mfaVerifiedAt,
            mfaMethod: existing.mfaMethod,
            expiresAt: this.addDays(now, policy.refreshTokenTtlDays),
          },
        });
        const replaced = await database.authSession.updateMany({
          where: {
            id: existing.id,
            revokedAt: null,
            replacedById: null,
          },
          data: {
            revokedAt: now,
            revokedReason: 'ROTATED',
            replacedById: created.id,
            lastUsedAt: now,
          },
        });

        if (replaced.count !== 1) {
          throw new RefreshReplayDetected(existing.tokenFamilyId);
        }

        return created;
      });

      return this.issue(
        { id: existing.userId, tenantId: existing.user.tenantId },
        next.id,
        this.mfaMethod(existing.mfaMethod),
        nextRefreshToken,
        policy,
      );
    } catch (error) {
      if (error instanceof RefreshReplayDetected) {
        await this.revokeFamily(error.tokenFamilyId, 'REFRESH_TOKEN_REPLAY');
        await this.auditReplay(
          existing.user.tenantId,
          existing.userId,
          error.tokenFamilyId,
          metadata,
        );
        throw this.sessionExpired();
      }
      throw error;
    }
  }

  async revoke(userId: string, sessionId: string, reason = 'USER_REVOKED'): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAll(userId: string, reason = 'USER_REVOKED_ALL'): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  async list(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        authenticatedAt: { not: null },
      },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        mfaMethod: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });

    return sessions.map((session) => ({
      ...session,
      current: session.id === currentSessionId,
    }));
  }

  private async issue(
    user: SessionUser,
    sessionId: string,
    mfaMethod: MfaAuthenticationMethod | null,
    refreshToken: string,
    policy: SessionPolicy,
  ): Promise<IssuedSession> {
    const authenticatedUser: AuthenticatedUser = {
      userId: user.id,
      tenantId: user.tenantId,
      sessionId,
      authenticationMethods: mfaMethod === null ? ['password'] : ['password', mfaMethod],
    };

    return {
      accessToken: await this.tokens.signAccessToken(
        authenticatedUser,
        policy.accessTokenTtlMinutes,
      ),
      accessTokenExpiresInSeconds: policy.accessTokenTtlMinutes * 60,
      refreshToken,
      refreshTokenExpiresInSeconds: policy.refreshTokenTtlDays * 86_400,
      user: authenticatedUser,
    };
  }

  private async revokeFamily(tokenFamilyId: string, reason: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { tokenFamilyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  private async auditReplay(
    tenantId: string,
    userId: string,
    tokenFamilyId: string,
    metadata: IdentityRequestMetadata,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId,
        actorUserId: userId,
        action: 'identity.refresh.replay',
        resourceType: 'AUTH_SESSION_FAMILY',
        result: 'DENIED',
        ipAddress: metadata.ipAddress ?? null,
        userAgent: metadata.userAgent ?? null,
        requestId: metadata.requestId ?? null,
        details: { tokenFamilyId },
      },
    });
  }

  private mfaMethod(value: string | null): MfaAuthenticationMethod | null {
    return value === 'totp' || value === 'recovery_code' ? value : null;
  }

  private addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
  }

  private addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 86_400_000);
  }

  private sessionExpired(): ApiException {
    return new ApiException(
      HttpStatus.UNAUTHORIZED,
      'SESSION_EXPIRED',
      '登录状态已失效，请重新登录',
    );
  }
}
