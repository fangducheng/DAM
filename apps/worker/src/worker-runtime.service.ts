import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ClaimedMaintenanceJob } from './maintenance/maintenance-job.types.js';
import { MaintenanceProcessorService } from './maintenance/maintenance-processor.service.js';
import { MaintenanceQueueService } from './maintenance/maintenance-queue.service.js';
import { AssetProcessingService } from './processing/asset-processing.service.js';
import type { ClaimedProcessingJob } from './processing/processing-job.types.js';
import { ProcessingQueueService } from './processing/processing-queue.service.js';

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private readonly processingEnabled: boolean;
  private readonly maintenanceEnabled: boolean;
  private readonly pollIntervalMs: number;
  private active = false;
  private preferMaintenance = true;
  private waitTimer: NodeJS.Timeout | undefined;
  private resolveWait: (() => void) | undefined;
  private loop?: Promise<void>;

  constructor(
    private readonly processingQueue: ProcessingQueueService,
    private readonly processor: AssetProcessingService,
    private readonly maintenanceQueue: MaintenanceQueueService,
    private readonly maintenance: MaintenanceProcessorService,
    config: ConfigService,
  ) {
    this.processingEnabled = config.getOrThrow<boolean>('PROCESSING_WORKER_ENABLED');
    this.maintenanceEnabled = config.getOrThrow<boolean>('MAINTENANCE_WORKER_ENABLED');
    this.pollIntervalMs = Math.min(
      config.getOrThrow<number>('PROCESSING_POLL_INTERVAL_MS'),
      config.getOrThrow<number>('MAINTENANCE_POLL_INTERVAL_MS'),
    );
  }

  onModuleInit(): void {
    if (!this.processingEnabled) this.logger.warn('Processing worker is disabled by configuration');
    if (!this.maintenanceEnabled)
      this.logger.warn('Maintenance worker is disabled by configuration');
    if (!this.processingEnabled && !this.maintenanceEnabled) return;
    this.active = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.active = false;
    this.resolveWait?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.active) {
      try {
        const firstWorked = this.preferMaintenance
          ? await this.runMaintenanceOnce()
          : await this.runProcessingOnce();
        if (firstWorked) {
          this.preferMaintenance = !this.preferMaintenance;
          continue;
        }
        const secondWorked = this.preferMaintenance
          ? await this.runProcessingOnce()
          : await this.runMaintenanceOnce();
        if (secondWorked) {
          this.preferMaintenance = !this.preferMaintenance;
          continue;
        }
      } catch (error) {
        this.logger.error(
          `Worker queue poll failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.wait();
    }
  }

  private async runProcessingOnce(): Promise<boolean> {
    if (!this.processingEnabled) return false;
    const job = await this.processingQueue.claim();
    if (job === null) return false;
    if (job.attempts > job.maxAttempts) {
      await this.handleProcessingFailure(
        job,
        new Error('Processing job exceeded maximum attempts'),
      );
      return true;
    }
    try {
      await this.processor.process(job);
      await this.processingQueue.complete(job.id);
      this.logger.log(`Completed ${job.jobType} processing job ${job.id}`);
    } catch (error) {
      await this.handleProcessingFailure(job, error);
    }
    return true;
  }

  private async runMaintenanceOnce(): Promise<boolean> {
    if (!this.maintenanceEnabled) return false;
    const job = await this.maintenanceQueue.claim();
    if (job === null) return false;
    if (job.attempts > job.maxAttempts) {
      await this.handleMaintenanceFailure(
        job,
        new Error('Maintenance job exceeded maximum attempts'),
      );
      return true;
    }
    try {
      await this.maintenance.process(job);
      await this.maintenanceQueue.complete(job.id);
      this.logger.log(`Completed ${job.jobType} maintenance job ${job.id}`);
    } catch (error) {
      await this.handleMaintenanceFailure(job, error);
    }
    return true;
  }

  private async handleProcessingFailure(job: ClaimedProcessingJob, error: unknown): Promise<void> {
    try {
      const result = await this.processingQueue.fail(job, error, (database, terminal) =>
        this.processor.recordFailure(database, job, terminal, error),
      );
      this.logger.warn(
        `${job.jobType} processing job ${job.id} ${result.toLowerCase()}: ${this.message(error)}`,
      );
    } catch (failureError) {
      this.logger.error(
        `Could not record processing failure for ${job.id}: ${this.message(failureError)}`,
      );
    }
  }

  private async handleMaintenanceFailure(
    job: ClaimedMaintenanceJob,
    error: unknown,
  ): Promise<void> {
    try {
      const result = await this.maintenanceQueue.fail(job, error, (database, terminal) =>
        this.maintenance.recordFailure(database, job, terminal, error),
      );
      this.logger.warn(
        `${job.jobType} maintenance job ${job.id} ${result.toLowerCase()}: ${this.message(error)}`,
      );
    } catch (failureError) {
      this.logger.error(
        `Could not record maintenance failure for ${job.id}: ${this.message(failureError)}`,
      );
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.waitTimer) clearTimeout(this.waitTimer);
        this.waitTimer = undefined;
        this.resolveWait = undefined;
        resolve();
      };
      this.resolveWait = finish;
      this.waitTimer = setTimeout(finish, this.pollIntervalMs);
    });
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
