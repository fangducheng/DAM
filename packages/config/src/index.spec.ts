import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './index.js';

describe('validateEnvironment', () => {
  it('applies safe local defaults', () => {
    const environment = validateEnvironment({});

    expect(environment.API_PORT).toBe(3000);
    expect(environment.COOKIE_SECURE).toBe(false);
    expect(environment.DATABASE_URL).toContain('localhost:5433');
    expect(environment.NODE_ENV).toBe('development');
  });

  it('rejects an invalid API port', () => {
    expect(() => validateEnvironment({ API_PORT: '70000' })).toThrow();
  });

  it('parses secure-cookie configuration from environment strings', () => {
    expect(validateEnvironment({ COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    expect(validateEnvironment({ COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('rejects local secrets in production', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production', COOKIE_SECURE: 'true' })).toThrow();
  });
});
