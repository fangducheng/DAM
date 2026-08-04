import { performance } from 'node:perf_hooks';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  DependencyHealth,
  DependencyName,
  LivenessResponse,
  ReadinessResponse,
} from '@dam/contracts';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { RedisService } from '../infrastructure/redis.service.js';

@Injectable()
export class HealthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly objectStorage: ObjectStorageService,
  ) {}

  liveness(): LivenessResponse {
    return {
      status: 'ok',
      service: 'dam-api',
      version: this.config.get('APP_VERSION', '0.1.0'),
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessResponse> {
    const dependencies = await Promise.all([
      this.probe('database', () => this.prisma.ping()),
      this.probe('redis', () => this.redis.ping()),
      this.probe('objectStorage', () => this.objectStorage.ping()),
    ]);

    return {
      status: dependencies.every((dependency) => dependency.status === 'up') ? 'ready' : 'degraded',
      service: 'dam-api',
      version: this.config.get('APP_VERSION', '0.1.0'),
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  private async probe(
    name: DependencyName,
    operation: () => Promise<void>,
  ): Promise<DependencyHealth> {
    const startedAt = performance.now();
    try {
      await operation();
      return {
        name,
        status: 'up',
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return {
        name,
        status: 'down',
        latencyMs: Math.round(performance.now() - startedAt),
        detail: error instanceof Error ? error.message : 'Unknown dependency error',
      };
    }
  }
}
