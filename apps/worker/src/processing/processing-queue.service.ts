import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '@dam/database';

import { PrismaService } from '../infrastructure/prisma.service.js';
import { type ClaimedProcessingJob, retryDelaySeconds } from './processing-job.types.js';

@Injectable()
export class ProcessingQueueService {
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly retryBaseSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const workerName = config.getOrThrow<string>('PROCESSING_WORKER_ID');
    this.workerId = `${workerName.slice(0, 75)}-${randomUUID()}`;
    this.leaseSeconds = config.getOrThrow<number>('PROCESSING_LEASE_SECONDS');
    this.retryBaseSeconds = config.getOrThrow<number>('PROCESSING_RETRY_BASE_SECONDS');
  }

  async claim(): Promise<ClaimedProcessingJob | null> {
    const jobs = await this.prisma.$queryRaw<ClaimedProcessingJob[]>(Prisma.sql`
      WITH candidate AS (
        SELECT "id"
        FROM "processing_jobs"
        WHERE (
          ("status" = 'PENDING' AND "available_at" <= CURRENT_TIMESTAMP)
          OR
          ("status" = 'RUNNING' AND "lease_expires_at" <= CURRENT_TIMESTAMP)
        )
        ORDER BY "available_at", "created_at", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "processing_jobs" AS job
      SET
        "status" = 'RUNNING',
        "attempts" = job."attempts" + 1,
        "locked_at" = CURRENT_TIMESTAMP,
        "locked_by" = ${this.workerId},
        "lease_expires_at" = CURRENT_TIMESTAMP + (${this.leaseSeconds} * INTERVAL '1 second'),
        "error_message" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      FROM candidate
      WHERE job."id" = candidate."id"
      RETURNING
        job."id",
        job."asset_version_id" AS "assetVersionId",
        job."job_type" AS "jobType",
        job."attempts",
        job."max_attempts" AS "maxAttempts",
        job."locked_by" AS "lockedBy"
    `);
    return jobs[0] ?? null;
  }

  async complete(jobId: string): Promise<void> {
    const result = await this.prisma.processingJob.updateMany({
      where: {
        id: jobId,
        status: 'RUNNING',
        lockedBy: this.workerId,
        leaseExpiresAt: { gt: new Date() },
      },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        errorMessage: null,
      },
    });
    if (result.count !== 1) {
      throw new Error(`Processing job ${jobId} lease was lost`);
    }
  }

  async fail(
    job: ClaimedProcessingJob,
    error: unknown,
    recordFailure: (database: Prisma.TransactionClient, terminal: boolean) => Promise<void>,
  ): Promise<'RETRY' | 'DEAD'> {
    const terminal = job.attempts >= job.maxAttempts;
    const message = this.errorMessage(error);
    return this.prisma.$transaction(async (database) => {
      const result = await database.processingJob.updateMany({
        where: {
          id: job.id,
          status: 'RUNNING',
          lockedBy: this.workerId,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: terminal ? 'DEAD' : 'PENDING',
          availableAt: terminal
            ? new Date()
            : new Date(Date.now() + retryDelaySeconds(job.attempts, this.retryBaseSeconds) * 1_000),
          completedAt: terminal ? new Date() : null,
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          errorMessage: message,
        },
      });
      if (result.count !== 1) {
        throw new Error(`Processing job ${job.id} lease was lost`);
      }
      await recordFailure(database, terminal);
      return terminal ? 'DEAD' : 'RETRY';
    });
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n]+/g, ' ').slice(0, 2_000);
  }
}
