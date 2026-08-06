import { z } from 'zod';

const localSecrets = {
  jwt: 'dam_local_access_secret_change_before_production',
  passwordPepper: 'dam_local_password_pepper',
  tokenHash: 'dam_local_token_hash_secret_change_before_production',
  totp: 'dam_local_totp_encryption_key_change_me',
} as const;

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgresql://dam:dam_local_password@localhost:5433/dam?schema=public'),
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    MINIO_ENDPOINT: z.string().url().default('http://localhost:9000'),
    MINIO_ACCESS_KEY: z.string().min(3).default('dam_local_admin'),
    MINIO_SECRET_KEY: z.string().min(8).default('dam_local_password'),
    MINIO_BUCKET: z.string().min(3).default('dam-assets'),
    RABBITMQ_URL: z.string().url().default('amqp://dam:dam_local_password@localhost:5672'),
    JWT_ISSUER: z.string().min(1).default('enterprise-dam'),
    JWT_AUDIENCE: z.string().min(1).default('enterprise-dam-api'),
    JWT_ACCESS_SECRET: z.string().min(32).default(localSecrets.jwt),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    MFA_CHALLENGE_TTL_MINUTES: z.coerce.number().int().min(1).max(15).default(5),
    PASSWORD_PEPPER: z.string().min(16).default(localSecrets.passwordPepper),
    TOKEN_HASH_SECRET: z.string().min(32).default(localSecrets.tokenHash),
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).max(262144).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),
    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(12).max(128).default(12),
    TOTP_ENCRYPTION_KEY: z.string().min(32).default(localSecrets.totp),
    REFRESH_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('dam_refresh'),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100).default(10),
    AUTHORIZATION_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    ASSET_UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(24),
    ASSET_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    ASSET_READ_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(60),
    ASSET_PROCESSING_MODE: z.enum(['deferred', 'local-bypass']).default('local-bypass'),
    PROCESSING_WORKER_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false),
    PROCESSING_WORKER_ID: z.string().min(1).max(120).default('dam-worker-local'),
    PROCESSING_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(2_000),
    PROCESSING_LEASE_SECONDS: z.coerce.number().int().min(30).max(1_800).default(120),
    PROCESSING_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
    MAINTENANCE_WORKER_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(true),
    MAINTENANCE_WORKER_ID: z.string().min(1).max(120).default('dam-maintenance-local'),
    MAINTENANCE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(2_000),
    MAINTENANCE_LEASE_SECONDS: z.coerce.number().int().min(30).max(1_800).default(120),
    MAINTENANCE_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
    MAINTENANCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
    MAINTENANCE_SCHEDULER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(60_000),
    RECYCLE_RETENTION_DAYS: z.coerce.number().int().min(30).max(30).default(30),
    NOTIFICATION_READ_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(180),
    NOTIFICATION_ARCHIVED_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),
    COMPLETED_JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    CLAMAV_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false),
    CLAMAV_HOST: z.string().min(1).default('127.0.0.1'),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
    CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(120_000),
    CLAMAV_MAX_STREAM_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(4_294_967_295)
      .default(536_870_912),
    TIKA_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false),
    TIKA_ENDPOINT: z.string().url().default('http://127.0.0.1:9998'),
    TIKA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(120_000),
    CONTENT_EXTRACTION_MAX_CHARS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(10_000_000)
      .default(1_000_000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    APP_VERSION: z.string().default('0.1.0'),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== 'production') {
      return;
    }

    const productionSecrets = [
      ['JWT_ACCESS_SECRET', environment.JWT_ACCESS_SECRET, localSecrets.jwt],
      ['PASSWORD_PEPPER', environment.PASSWORD_PEPPER, localSecrets.passwordPepper],
      ['TOKEN_HASH_SECRET', environment.TOKEN_HASH_SECRET, localSecrets.tokenHash],
      ['TOTP_ENCRYPTION_KEY', environment.TOTP_ENCRYPTION_KEY, localSecrets.totp],
    ] as const;

    for (const [field, value, localDefault] of productionSecrets) {
      if (value === localDefault) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must be replaced in production`,
        });
      }
    }

    if (!environment.COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production',
      });
    }

    if (environment.ASSET_PROCESSING_MODE === 'local-bypass') {
      context.addIssue({
        code: 'custom',
        path: ['ASSET_PROCESSING_MODE'],
        message: 'ASSET_PROCESSING_MODE must be deferred in production',
      });
    }

    if (environment.PROCESSING_WORKER_ENABLED && !environment.CLAMAV_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CLAMAV_ENABLED'],
        message: 'CLAMAV_ENABLED must be true for a production processing worker',
      });
    }

    if (!environment.MAINTENANCE_WORKER_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['MAINTENANCE_WORKER_ENABLED'],
        message: 'MAINTENANCE_WORKER_ENABLED must be true in production',
      });
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): AppEnvironment {
  return environmentSchema.parse(input);
}
