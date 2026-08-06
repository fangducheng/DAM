import { reactive } from 'vue';

import type { AuthenticatedUser } from '@dam/contracts';

import { apiRequest, clearAccessToken, refreshAccessToken, setAccessToken } from '../lib/api';
import type { MfaChallengeResponse, SessionResponse } from '../lib/types';

type AuthStatus = 'bootstrapping' | 'anonymous' | 'authenticated' | 'mfa_required';

interface AuthState {
  status: AuthStatus;
  user: AuthenticatedUser | null;
  challengeToken: string | null;
  challengeExpiresAt: number | null;
}

const state = reactive<AuthState>({
  status: 'bootstrapping',
  user: null,
  challengeToken: null,
  challengeExpiresAt: null,
});

let bootstrapPromise: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
  if (state.status !== 'bootstrapping') return;
  bootstrapPromise ??= refreshAccessToken()
    .then((session) => acceptSession(session))
    .catch(() => setAnonymous())
    .finally(() => {
      bootstrapPromise = null;
    });
  return bootstrapPromise;
}

async function login(input: {
  tenantCode: string;
  identifier: string;
  password: string;
}): Promise<'authenticated' | 'mfa_required'> {
  const result = await apiRequest<SessionResponse | MfaChallengeResponse>(
    '/api/v1/identity/login',
    {
      method: 'POST',
      auth: false,
      body: JSON.stringify(input),
    },
  );
  if ('mfaRequired' in result) {
    state.status = 'mfa_required';
    state.challengeToken = result.challengeToken;
    state.challengeExpiresAt = Date.now() + result.expiresInSeconds * 1000;
    return 'mfa_required';
  }
  acceptSession(result);
  return 'authenticated';
}

async function completeMfa(code: string): Promise<void> {
  if (state.challengeToken === null) throw new Error('MFA challenge is unavailable');
  const session = await apiRequest<SessionResponse>('/api/v1/identity/login/mfa', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ challengeToken: state.challengeToken, code }),
  });
  acceptSession(session);
}

async function logout(): Promise<void> {
  try {
    await apiRequest<void>('/api/v1/identity/logout', { method: 'POST' });
  } finally {
    setAnonymous();
  }
}

function acceptSession(session: SessionResponse): void {
  setAccessToken(session.accessToken);
  state.user = session.user;
  state.status = 'authenticated';
  state.challengeToken = null;
  state.challengeExpiresAt = null;
}

function setAnonymous(): void {
  clearAccessToken();
  state.status = 'anonymous';
  state.user = null;
  state.challengeToken = null;
  state.challengeExpiresAt = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('dam:session-refreshed', (event) => {
    acceptSession((event as CustomEvent<SessionResponse>).detail);
  });
  window.addEventListener('dam:session-expired', () => setAnonymous());
}

export const authStore = {
  state,
  bootstrap,
  login,
  completeMfa,
  logout,
  setAnonymous,
};
