import type { ApiErrorCode, ApiErrorResponse, ApiFieldError } from '@dam/contracts';

import type { SessionResponse } from './types';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly requestId: string,
    readonly fieldErrors: readonly ApiFieldError[] = [],
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface ApiRequestOptions extends Omit<RequestInit, 'headers'> {
  auth?: boolean;
  headers?: HeadersInit;
  retryAuthentication?: boolean;
}

let accessToken: string | null = null;
let refreshPromise: Promise<SessionResponse> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}

export async function refreshAccessToken(): Promise<SessionResponse> {
  refreshPromise ??= performRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { auth = true, retryAuthentication = true, ...requestInit } = options;
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (requestInit.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (auth && accessToken !== null) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  let response: Response;
  try {
    response = await fetch(path, { ...requestInit, credentials: 'include', headers });
  } catch {
    throw new ApiClientError('无法连接服务器，请检查网络后重试', 0, 'INTERNAL_ERROR', '');
  }

  if (response.status === 401 && auth && retryAuthentication) {
    try {
      await refreshAccessToken();
    } catch (error) {
      clearAccessToken();
      dispatch('dam:session-expired');
      throw error;
    }
    return apiRequest<T>(path, { ...options, retryAuthentication: false });
  }

  return parseResponse<T>(response);
}

async function performRefresh(): Promise<SessionResponse> {
  let response: Response;
  try {
    response = await fetch('/api/v1/identity/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiClientError('无法恢复登录状态，请重新登录', 0, 'SESSION_EXPIRED', '');
  }
  const session = await parseResponse<SessionResponse>(response);
  setAccessToken(session.accessToken);
  dispatch('dam:session-refreshed', session);
  return session;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  let body: Partial<ApiErrorResponse> = {};
  try {
    body = (await response.json()) as Partial<ApiErrorResponse>;
  } catch {
    // The fallback below keeps proxy and gateway errors inside the same UI contract.
  }
  const retryAfter = response.headers.get('Retry-After');
  const error = new ApiClientError(
    body.message ?? defaultMessage(response.status),
    response.status,
    body.code ?? statusCode(response.status),
    body.requestId ?? '',
    body.fieldErrors ?? [],
    retryAfter === null ? null : Number.parseInt(retryAfter, 10),
  );
  if (error.code === 'VERSION_CONFLICT') dispatch('dam:data-conflict');
  throw error;
}

function dispatch(name: string, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, detail === undefined ? {} : { detail }));
}

function statusCode(status: number): ApiErrorCode {
  if (status === 400) return 'VALIDATION_FAILED';
  if (status === 401) return 'SESSION_EXPIRED';
  if (status === 403) return 'ACCESS_DENIED';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 409) return 'VERSION_CONFLICT';
  if (status === 410) return 'INVITATION_EXPIRED';
  if (status === 429) return 'TOO_MANY_ATTEMPTS';
  return 'INTERNAL_ERROR';
}

function defaultMessage(status: number): string {
  if (status === 401) return '登录状态已失效，请重新登录';
  if (status === 403) return '你无权执行此操作';
  if (status === 404) return '资源不存在或你无权查看';
  if (status === 409) return '数据已发生变化，请刷新后重试';
  if (status === 410) return '邀请已过期，请联系管理员重新邀请';
  if (status === 429) return '操作过于频繁，请稍后重试';
  return '服务暂时不可用，请稍后重试';
}
