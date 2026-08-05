import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { AuthenticatedUser } from '@dam/contracts';

interface BaseClaims {
  sub: string;
  tenantId: string;
  sessionId: string;
  purpose: 'access' | 'mfa';
}

export interface AccessTokenClaims extends BaseClaims {
  purpose: 'access';
  amr: AuthenticatedUser['authenticationMethods'];
}

export interface MfaChallengeClaims extends BaseClaims {
  purpose: 'mfa';
  amr: readonly ['password'];
}

@Injectable()
export class IdentityTokenService {
  private readonly audience: string;
  private readonly issuer: string;
  private readonly secret: string;
  private readonly challengeTtlMinutes: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.audience = config.getOrThrow<string>('JWT_AUDIENCE');
    this.issuer = config.getOrThrow<string>('JWT_ISSUER');
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.challengeTtlMinutes = config.getOrThrow<number>('MFA_CHALLENGE_TTL_MINUTES');
  }

  signAccessToken(user: AuthenticatedUser, ttlMinutes: number): Promise<string> {
    return this.jwt.signAsync(
      {
        tenantId: user.tenantId,
        sessionId: user.sessionId,
        purpose: 'access',
        amr: user.authenticationMethods,
      } satisfies Omit<AccessTokenClaims, 'sub'>,
      this.options(ttlMinutes, user.userId),
    );
  }

  signMfaChallenge(userId: string, tenantId: string, sessionId: string): Promise<string> {
    return this.jwt.signAsync(
      {
        tenantId,
        sessionId,
        purpose: 'mfa',
        amr: ['password'],
      } satisfies Omit<MfaChallengeClaims, 'sub'>,
      this.options(this.challengeTtlMinutes, userId),
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const claims = await this.verify(token);
    if (
      claims['purpose'] !== 'access' ||
      typeof claims['sub'] !== 'string' ||
      typeof claims['tenantId'] !== 'string' ||
      typeof claims['sessionId'] !== 'string' ||
      !this.isAuthenticationMethods(claims['amr'])
    ) {
      throw new Error('Invalid access token purpose');
    }

    return {
      sub: claims['sub'],
      tenantId: claims['tenantId'],
      sessionId: claims['sessionId'],
      purpose: 'access',
      amr: claims['amr'],
    };
  }

  async verifyMfaChallenge(token: string): Promise<MfaChallengeClaims> {
    const claims = await this.verify(token);
    if (
      claims['purpose'] !== 'mfa' ||
      typeof claims['sub'] !== 'string' ||
      typeof claims['tenantId'] !== 'string' ||
      typeof claims['sessionId'] !== 'string'
    ) {
      throw new Error('Invalid MFA challenge purpose');
    }

    return {
      sub: claims['sub'],
      tenantId: claims['tenantId'],
      sessionId: claims['sessionId'],
      purpose: 'mfa',
      amr: ['password'],
    };
  }

  private options(ttlMinutes: number, subject: string): Record<string, unknown> {
    return {
      secret: this.secret,
      issuer: this.issuer,
      audience: this.audience,
      subject,
      expiresIn: `${ttlMinutes}m`,
    };
  }

  private verify(token: string): Promise<Record<string, unknown>> {
    return this.jwt.verifyAsync<Record<string, unknown>>(token, {
      secret: this.secret,
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  private isAuthenticationMethods(value: unknown): value is AccessTokenClaims['amr'] {
    return (
      Array.isArray(value) &&
      value.includes('password') &&
      value.every(
        (method) => method === 'password' || method === 'totp' || method === 'recovery_code',
      )
    );
  }
}
