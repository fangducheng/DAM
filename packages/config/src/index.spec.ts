import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './index.js';

describe('validateEnvironment', () => {
  it('applies safe local defaults', () => {
    const environment = validateEnvironment({});

    expect(environment.API_PORT).toBe(3000);
    expect(environment.COOKIE_SECURE).toBe(false);
    expect(environment.DATABASE_URL).toContain('localhost:5433');
    expect(environment.NODE_ENV).toBe('development');
    expect(environment.ASSET_PROCESSING_MODE).toBe('local-bypass');
    expect(environment.PROCESSING_WORKER_ENABLED).toBe(false);
    expect(environment.MAINTENANCE_WORKER_ENABLED).toBe(true);
    expect(environment.MAINTENANCE_POLL_INTERVAL_MS).toBe(2_000);
    expect(environment.MAINTENANCE_LEASE_SECONDS).toBe(120);
    expect(environment.MAINTENANCE_RETRY_BASE_SECONDS).toBe(5);
    expect(environment.MAINTENANCE_MAX_ATTEMPTS).toBe(8);
    expect(environment.MAINTENANCE_SCHEDULER_INTERVAL_MS).toBe(60_000);
    expect(environment.RECYCLE_RETENTION_DAYS).toBe(30);
    expect(environment.NOTIFICATION_READ_RETENTION_DAYS).toBe(180);
    expect(environment.NOTIFICATION_ARCHIVED_RETENTION_DAYS).toBe(90);
    expect(environment.COMPLETED_JOB_RETENTION_DAYS).toBe(30);
    expect(environment.CLAMAV_ENABLED).toBe(false);
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

  it('requires deferred asset processing in production', () => {
    const production = {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      JWT_ACCESS_SECRET: 'production-jwt-secret-with-at-least-32-characters',
      PASSWORD_PEPPER: 'production-password-pepper',
      TOKEN_HASH_SECRET: 'production-token-hash-secret-with-at-least-32-characters',
      TOTP_ENCRYPTION_KEY: 'production-totp-key-with-at-least-32-characters',
    } as const;

    expect(() =>
      validateEnvironment({ ...production, ASSET_PROCESSING_MODE: 'local-bypass' }),
    ).toThrow();
    expect(
      validateEnvironment({ ...production, ASSET_PROCESSING_MODE: 'deferred' })
        .ASSET_PROCESSING_MODE,
    ).toBe('deferred');
  });

  it('parses processing worker controls and validates their ranges', () => {
    const environment = validateEnvironment({
      PROCESSING_WORKER_ENABLED: 'true',
      CLAMAV_ENABLED: 'true',
      PROCESSING_POLL_INTERVAL_MS: '500',
    });

    expect(environment.PROCESSING_WORKER_ENABLED).toBe(true);
    expect(environment.CLAMAV_ENABLED).toBe(true);
    expect(environment.PROCESSING_POLL_INTERVAL_MS).toBe(500);
    expect(() => validateEnvironment({ PROCESSING_LEASE_SECONDS: '10' })).toThrow();
  });

  it('requires ClamAV when the production processing worker is enabled', () => {
    const production = {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      JWT_ACCESS_SECRET: 'production-jwt-secret-with-at-least-32-characters',
      PASSWORD_PEPPER: 'production-password-pepper',
      TOKEN_HASH_SECRET: 'production-token-hash-secret-with-at-least-32-characters',
      TOTP_ENCRYPTION_KEY: 'production-totp-key-with-at-least-32-characters',
      ASSET_PROCESSING_MODE: 'deferred',
      PROCESSING_WORKER_ENABLED: 'true',
    } as const;

    expect(() => validateEnvironment(production)).toThrow();
    expect(validateEnvironment({ ...production, CLAMAV_ENABLED: 'true' }).CLAMAV_ENABLED).toBe(
      true,
    );
  });

  it('parses maintenance worker controls and lifecycle retention settings', () => {
    const environment = validateEnvironment({
      MAINTENANCE_WORKER_ENABLED: 'false',
      MAINTENANCE_POLL_INTERVAL_MS: '250',
      MAINTENANCE_LEASE_SECONDS: '1800',
      MAINTENANCE_RETRY_BASE_SECONDS: '300',
      MAINTENANCE_MAX_ATTEMPTS: '50',
      MAINTENANCE_SCHEDULER_INTERVAL_MS: '86400000',
      RECYCLE_RETENTION_DAYS: '30',
      NOTIFICATION_READ_RETENTION_DAYS: '3650',
      NOTIFICATION_ARCHIVED_RETENTION_DAYS: '1',
      COMPLETED_JOB_RETENTION_DAYS: '365',
    });

    expect(environment.MAINTENANCE_WORKER_ENABLED).toBe(false);
    expect(environment.MAINTENANCE_POLL_INTERVAL_MS).toBe(250);
    expect(environment.MAINTENANCE_LEASE_SECONDS).toBe(1_800);
    expect(environment.MAINTENANCE_RETRY_BASE_SECONDS).toBe(300);
    expect(environment.MAINTENANCE_MAX_ATTEMPTS).toBe(50);
    expect(environment.MAINTENANCE_SCHEDULER_INTERVAL_MS).toBe(86_400_000);
    expect(environment.RECYCLE_RETENTION_DAYS).toBe(30);
    expect(environment.NOTIFICATION_READ_RETENTION_DAYS).toBe(3_650);
    expect(environment.NOTIFICATION_ARCHIVED_RETENTION_DAYS).toBe(1);
    expect(environment.COMPLETED_JOB_RETENTION_DAYS).toBe(365);
  });

  it.each([
    ['MAINTENANCE_WORKER_ENABLED', 'yes'],
    ['MAINTENANCE_POLL_INTERVAL_MS', '249'],
    ['MAINTENANCE_POLL_INTERVAL_MS', '30001'],
    ['MAINTENANCE_LEASE_SECONDS', '29'],
    ['MAINTENANCE_LEASE_SECONDS', '1801'],
    ['MAINTENANCE_RETRY_BASE_SECONDS', '0'],
    ['MAINTENANCE_RETRY_BASE_SECONDS', '301'],
    ['MAINTENANCE_MAX_ATTEMPTS', '0'],
    ['MAINTENANCE_MAX_ATTEMPTS', '51'],
    ['MAINTENANCE_SCHEDULER_INTERVAL_MS', '999'],
    ['MAINTENANCE_SCHEDULER_INTERVAL_MS', '86400001'],
    ['RECYCLE_RETENTION_DAYS', '29'],
    ['RECYCLE_RETENTION_DAYS', '31'],
    ['NOTIFICATION_READ_RETENTION_DAYS', '29'],
    ['NOTIFICATION_READ_RETENTION_DAYS', '3651'],
    ['NOTIFICATION_ARCHIVED_RETENTION_DAYS', '0'],
    ['NOTIFICATION_ARCHIVED_RETENTION_DAYS', '3651'],
    ['COMPLETED_JOB_RETENTION_DAYS', '0'],
    ['COMPLETED_JOB_RETENTION_DAYS', '366'],
  ])('rejects invalid lifecycle setting %s=%s', (field, value) => {
    expect(() => validateEnvironment({ [field]: value })).toThrow();
  });

  it('requires the maintenance worker to remain enabled in production', () => {
    const production = {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      JWT_ACCESS_SECRET: 'production-jwt-secret-with-at-least-32-characters',
      PASSWORD_PEPPER: 'production-password-pepper',
      TOKEN_HASH_SECRET: 'production-token-hash-secret-with-at-least-32-characters',
      TOTP_ENCRYPTION_KEY: 'production-totp-key-with-at-least-32-characters',
      ASSET_PROCESSING_MODE: 'deferred',
    } as const;

    expect(() =>
      validateEnvironment({ ...production, MAINTENANCE_WORKER_ENABLED: 'false' }),
    ).toThrow(/MAINTENANCE_WORKER_ENABLED/);
    expect(
      validateEnvironment({ ...production, MAINTENANCE_WORKER_ENABLED: 'true' })
        .MAINTENANCE_WORKER_ENABLED,
    ).toBe(true);
  });
});
