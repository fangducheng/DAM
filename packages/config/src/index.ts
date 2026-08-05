import { z } from 'zod';

export const environmentSchema = z.object({
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
  JWT_ACCESS_SECRET: z.string().min(32).default('dam_local_access_secret_change_before_production'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  PASSWORD_PEPPER: z.string().min(16).default('dam_local_password_pepper'),
  TOTP_ENCRYPTION_KEY: z.string().min(32).default('dam_local_totp_encryption_key_change_me'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  APP_VERSION: z.string().default('0.1.0'),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): AppEnvironment {
  return environmentSchema.parse(input);
}
