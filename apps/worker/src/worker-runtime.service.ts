import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AssetProcessingService } from './processing/asset-processing.service.js';
import type { ClaimedProcessingJob } from './processing/processing-job.types.js';
import { ProcessingQueueService } from './processing/processing-queue.service.js';

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private active = false;
  private waitTimer?: NodeJS.Timeout;

  constructor(
    private readonly queue: ProcessingQueueService,
    private readonly processor: AssetProcessingService,
    config: ConfigService,
  ) {
    this.enabled = config.getOrThrow<boolean>('PROCESSING_WORKER_ENABLED');
    this.pollIntervalMs = config.getOrThrow<number>('PROCESSING_POLL_INTERVAL_MS');
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('Processing worker is disabled by configuration');
      return;
    }
    this.active = true;
    void this.run();
  }

  onModuleDestroy(): void {
    this.active = false;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
    }
  }

  private async run(): Promise<void> {
    while (this.active) {
      let job: ClaimedProcessingJob | null = null;
      try {
        job = await this.queue.claim();
        if (job === null) {
          await this.wait();
          continue;
        }
        try {
          await this.processor.process(job);
        } catch (error) {
          await this.handleFailure(job, error);
          await this.wait();
          continue;
        }
        try {
          await this.queue.complete(job.id);
          this.logger.log(`Completed ${job.jobType} job ${job.id}`);
        } catch (error) {
          this.logger.error(
            `Could not acknowledge completed job ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Processing queue poll failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.wait();
      }
    }
  }

  private async handleFailure(job: ClaimedProcessingJob, error: unknown): Promise<void> {
    try {
      const result = await this.queue.fail(job, error, (database, failureIsTerminal) =>
        this.processor.recordFailure(database, job, failureIsTerminal, error),
      );
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${job.jobType} job ${job.id} ${result.toLowerCase()}: ${message}`);
    } catch (failureError) {
      this.logger.error(
        `Could not record failure for job ${job.id}: ${failureError instanceof Error ? failureError.message : String(failureError)}`,
      );
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waitTimer = setTimeout(resolve, this.pollIntervalMs);
      this.waitTimer.unref();
    });
  }
}
