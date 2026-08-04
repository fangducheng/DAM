import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { HealthService } from './health.service.js';
import type { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import type { PrismaService } from '../infrastructure/prisma.service.js';
import type { RedisService } from '../infrastructure/redis.service.js';

describe('HealthService', () => {
  it('returns deterministic liveness metadata', () => {
    const config = new ConfigService({ APP_VERSION: 'test-version' });
    const prisma = { ping: vi.fn() } as unknown as PrismaService;
    const redis = { ping: vi.fn() } as unknown as RedisService;
    const objectStorage = { ping: vi.fn() } as unknown as ObjectStorageService;
    const service = new HealthService(config, prisma, redis, objectStorage);

    const result = service.liveness();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('dam-api');
    expect(result.version).toBe('test-version');
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
