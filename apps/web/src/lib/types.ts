import type { AuthenticatedUser } from '@dam/contracts';

export interface SessionResponse {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  user: AuthenticatedUser;
}

export interface MfaChallengeResponse {
  mfaRequired: true;
  challengeToken: string;
  expiresInSeconds: number;
}

export interface InvitationAcceptanceResponse {
  accepted: boolean;
  mfaVerificationRequired: boolean;
  provisioningUri?: string;
}

export interface ConfirmedInvitationResponse {
  accepted: true;
  recoveryCodes: string[];
}

export interface SessionSummary {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  mfaMethod: string | null;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}
