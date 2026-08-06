import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest, ApiClientError, clearAccessToken } from './api';

const errorHeaders = { 'Content-Type': 'application/json' };

describe('API client', () => {
  beforeEach(() => {
    clearAccessToken();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves stable validation field errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 400,
            code: 'VALIDATION_FAILED',
            message: '提交的数据格式不正确',
            requestId: 'request-1',
            timestamp: new Date().toISOString(),
            fieldErrors: [{ field: 'email', code: 'isEmail', message: 'email must be an email' }],
          }),
          { status: 400, headers: errorHeaders },
        ),
      ),
    );

    const error = await apiRequest('/api/test', { auth: false }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: 'request-1',
      fieldErrors: [{ field: 'email', code: 'isEmail' }],
    });
  });

  it('deduplicates concurrent refreshes and retries with the new access token', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/identity/refresh')) {
        refreshCalls += 1;
        await refreshGate;
        return new Response(
          JSON.stringify({
            accessToken: 'fresh-token',
            accessTokenExpiresInSeconds: 900,
            user: {
              userId: '11111111-1111-1111-1111-111111111111',
              tenantId: '22222222-2222-2222-2222-222222222222',
              sessionId: '33333333-3333-3333-3333-333333333333',
              authenticationMethods: ['password', 'totp'],
            },
          }),
          { status: 200, headers: errorHeaders },
        );
      }
      const authorization = new Headers(init?.headers).get('Authorization');
      return authorization === 'Bearer fresh-token'
        ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: errorHeaders })
        : new Response(
            JSON.stringify({
              statusCode: 401,
              code: 'SESSION_EXPIRED',
              message: '登录状态已失效，请重新登录',
              requestId: 'request-2',
              timestamp: new Date().toISOString(),
            }),
            { status: 401, headers: errorHeaders },
          );
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = apiRequest<{ ok: boolean }>('/api/protected');
    const second = apiRequest<{ ok: boolean }>('/api/protected');
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh?.();

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCalls).toBe(1);
  });
});
