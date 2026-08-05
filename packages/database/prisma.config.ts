import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { defineConfig, env } from 'prisma/config';

const rootEnvPath = resolve(import.meta.dirname, '../../.env');

if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
