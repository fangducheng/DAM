import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Prisma } from '@dam/database';

import { PrismaService } from '../infrastructure/prisma.service.js';

@Injectable()
export class MaintenanceSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceSchedulerService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.enabled = config.getOrThrow<boolean>('MAINTENANCE_WORKER_ENABLED');
    this.intervalMs = config.getOrThrow<number>('MAINTENANCE_SCHEDULER_INTERVAL_MS');
    this.maxAttempts = config.getOrThrow<number>('MAINTENANCE_MAX_ATTEMPTS');
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    void this.schedule();
    this.timer = setInterval(() => void this.schedule(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async schedule(): Promise<void> {
    try {
      await this.prisma.$transaction(async (database) => {
        await this.scheduleDeletionBatches(database);
        await this.scheduleExpiredUploads(database);
        await this.scheduleDailyPruning(database);
      });
    } catch (error) {
      this.logger.error(
        `Maintenance scheduling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async scheduleDeletionBatches(database: Prisma.TransactionClient): Promise<void> {
    const batches = await database.deletionBatch.findMany({
      where: { status: 'RETAINED' },
      orderBy: { id: 'asc' },
      take: 500,
      select: { id: true, tenantId: true, spaceId: true, purgeAt: true },
    });
    const dayMs = 24 * 60 * 60 * 1_000;
    await database.maintenanceJob.createMany({
      data: batches.flatMap((batch) => [
        {
          tenantId: batch.tenantId,
          spaceId: batch.spaceId,
          jobType: 'RETENTION_WARNING' as const,
          idempotencyKey: `deletion:${batch.id}:warning:7`,
          targetId: batch.id,
          payload: { daysRemaining: 7 },
          availableAt: new Date(batch.purgeAt.getTime() - 7 * dayMs),
          maxAttempts: this.maxAttempts,
        },
        {
          tenantId: batch.tenantId,
          spaceId: batch.spaceId,
          jobType: 'RETENTION_WARNING' as const,
          idempotencyKey: `deletion:${batch.id}:warning:1`,
          targetId: batch.id,
          payload: { daysRemaining: 1 },
          availableAt: new Date(batch.purgeAt.getTime() - dayMs),
          maxAttempts: this.maxAttempts,
        },
        {
          tenantId: batch.tenantId,
          spaceId: batch.spaceId,
          jobType: 'PURGE_DELETION_BATCH' as const,
          idempotencyKey: `deletion:${batch.id}:purge`,
          targetId: batch.id,
          availableAt: batch.purgeAt,
          maxAttempts: this.maxAttempts,
        },
      ]),
      skipDuplicates: true,
    });
  }

  private async scheduleExpiredUploads(database: Prisma.TransactionClient): Promise<void> {
    const sessions = await database.uploadSession.findMany({
      where: { status: { in: ['CREATED', 'UPLOADING'] } },
      orderBy: { id: 'asc' },
      take: 500,
      select: { id: true, spaceId: true, expiresAt: true, space: { select: { tenantId: true } } },
    });
    await database.maintenanceJob.createMany({
      data: sessions.map((session) => ({
        tenantId: session.space.tenantId,
        spaceId: session.spaceId,
        jobType: 'EXPIRE_UPLOAD_SESSION',
        idempotencyKey: `upload:${session.id}:expire`,
        targetId: session.id,
        availableAt: session.expiresAt,
        maxAttempts: this.maxAttempts,
      })),
      skipDuplicates: true,
    });
  }

  private async scheduleDailyPruning(database: Prisma.TransactionClient): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const tenants = await database.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    await database.maintenanceJob.createMany({
      data: tenants.flatMap(({ id: tenantId }) => [
        {
          tenantId,
          jobType: 'PRUNE_NOTIFICATIONS' as const,
          idempotencyKey: `retention:${tenantId}:notifications:${date}`,
          maxAttempts: this.maxAttempts,
        },
        {
          tenantId,
          jobType: 'PRUNE_COMPLETED_JOBS' as const,
          idempotencyKey: `retention:${tenantId}:jobs:${date}`,
          maxAttempts: this.maxAttempts,
        },
      ]),
      skipDuplicates: true,
    });
  }
}
