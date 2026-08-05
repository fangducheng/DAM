import type { AuthenticatedUser } from '@dam/contracts';

export interface IdentityRequestMetadata {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface SessionPolicy {
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
}

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  user: AuthenticatedUser;
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  expiresInSeconds: number;
}

export interface SessionSummary {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  mfaMethod: string | null;
  lastUsedAt: Date;
  expiresAt: Date;
  current: boolean;
}
