import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { MaintenanceProcessorService } from './maintenance/maintenance-processor.service.js';
import type { MaintenanceQueueService } from './maintenance/maintenance-queue.service.js';
import type { AssetProcessingService } from './processing/asset-processing.service.js';
import type { ProcessingQueueService } from './processing/processing-queue.service.js';
import { WorkerRuntimeService } from './worker-runtime.service.js';

describe('WorkerRuntimeService', () => {
  it('keeps the process alive while waiting for maintenance work', async () => {
    const claim = vi.fn().mockResolvedValue(null);
    const maintenanceQueue = {
      claim,
    } as unknown as MaintenanceQueueService;
    const values: Record<string, boolean | number> = {
      PROCESSING_WORKER_ENABLED: false,
      MAINTENANCE_WORKER_ENABLED: true,
      PROCESSING_POLL_INTERVAL_MS: 60_000,
      MAINTENANCE_POLL_INTERVAL_MS: 60_000,
    };
    const config = {
      getOrThrow: vi.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const runtime = new WorkerRuntimeService(
      {} as ProcessingQueueService,
      {} as AssetProcessingService,
      maintenanceQueue,
      {} as MaintenanceProcessorService,
      config,
    );

    runtime.onModuleInit();
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect((runtime as unknown as { waitTimer?: NodeJS.Timeout }).waitTimer).toBeDefined(),
    );

    const timer = (runtime as unknown as { waitTimer?: NodeJS.Timeout }).waitTimer;
    expect(timer?.hasRef()).toBe(true);

    await runtime.onModuleDestroy();
  });

  it('delegates reconciliation maintenance jobs and completes their queue lease', async () => {
    const job = {
      id: '00000000-0000-7000-8000-000000000001',
      idempotencyKey: 'reconciliation:00000000-0000-7000-8000-000000000003:step:0',
      tenantId: '00000000-0000-7000-8000-000000000002',
      spaceId: null,
      jobType: 'RECONCILE_STORAGE_STEP' as const,
      targetId: '00000000-0000-7000-8000-000000000003',
      payload: { phase: 'DATABASE_SCAN', checkpointVersion: 0 },
      attempts: 1,
      maxAttempts: 8,
      lockedBy: 'worker-test',
    };
    const claim = vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null);
    const complete = vi.fn().mockResolvedValue(undefined);
    const maintenanceQueue = { claim, complete } as unknown as MaintenanceQueueService;
    const process = vi.fn().mockResolvedValue(undefined);
    const maintenance = { process } as unknown as MaintenanceProcessorService;
    const values: Record<string, boolean | number> = {
      PROCESSING_WORKER_ENABLED: false,
      MAINTENANCE_WORKER_ENABLED: true,
      PROCESSING_POLL_INTERVAL_MS: 60_000,
      MAINTENANCE_POLL_INTERVAL_MS: 60_000,
    };
    const config = {
      getOrThrow: vi.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const runtime = new WorkerRuntimeService(
      {} as ProcessingQueueService,
      {} as AssetProcessingService,
      maintenanceQueue,
      maintenance,
      config,
    );

    runtime.onModuleInit();
    await vi.waitFor(() => expect(process).toHaveBeenCalledWith(job));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(job.id));
    await runtime.onModuleDestroy();
  });

  it('marks an over-attempt maintenance job dead without invoking its processor', async () => {
    const job = {
      id: '00000000-0000-7000-8000-000000000011',
      idempotencyKey: 'reconciliation:00000000-0000-7000-8000-000000000013:step:0',
      tenantId: '00000000-0000-7000-8000-000000000012',
      spaceId: null,
      jobType: 'RECONCILE_STORAGE_STEP' as const,
      targetId: '00000000-0000-7000-8000-000000000013',
      payload: { phase: 'DATABASE_SCAN', checkpointVersion: 0 },
      attempts: 9,
      maxAttempts: 8,
      lockedBy: 'worker-test',
    };
    const database = {};
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn(
      async (
        _job: typeof job,
        _error: unknown,
        callback: (transaction: never, terminal: boolean) => Promise<void>,
      ) => {
        await callback(database as never, true);
        return 'DEAD' as const;
      },
    );
    const claim = vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null);
    const complete = vi.fn().mockResolvedValue(undefined);
    const maintenanceQueue = { claim, complete, fail } as unknown as MaintenanceQueueService;
    const process = vi.fn().mockResolvedValue(undefined);
    const maintenance = { process, recordFailure } as unknown as MaintenanceProcessorService;
    const values: Record<string, boolean | number> = {
      PROCESSING_WORKER_ENABLED: false,
      MAINTENANCE_WORKER_ENABLED: true,
      PROCESSING_POLL_INTERVAL_MS: 60_000,
      MAINTENANCE_POLL_INTERVAL_MS: 60_000,
    };
    const config = {
      getOrThrow: vi.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const runtime = new WorkerRuntimeService(
      {} as ProcessingQueueService,
      {} as AssetProcessingService,
      maintenanceQueue,
      maintenance,
      config,
    );

    runtime.onModuleInit();
    await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
    const failure = fail.mock.calls[0]![1];
    expect(failure).toEqual(new Error('Maintenance job exceeded maximum attempts'));
    expect(recordFailure).toHaveBeenCalledWith(database, job, true, failure);
    expect(process).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    await runtime.onModuleDestroy();
  });

  it('marks an over-attempt processing job dead without invoking its processor', async () => {
    const job = {
      id: '00000000-0000-7000-8000-000000000021',
      assetVersionId: '00000000-0000-7000-8000-000000000022',
      jobType: 'MALWARE_SCAN',
      attempts: 9,
      maxAttempts: 8,
      lockedBy: 'worker-test',
    };
    const database = {};
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn(
      async (
        _job: typeof job,
        _error: unknown,
        callback: (transaction: never, terminal: boolean) => Promise<void>,
      ) => {
        await callback(database as never, true);
        return 'DEAD' as const;
      },
    );
    const claim = vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null);
    const complete = vi.fn().mockResolvedValue(undefined);
    const processingQueue = { claim, complete, fail } as unknown as ProcessingQueueService;
    const process = vi.fn().mockResolvedValue(undefined);
    const processor = { process, recordFailure } as unknown as AssetProcessingService;
    const values: Record<string, boolean | number> = {
      PROCESSING_WORKER_ENABLED: true,
      MAINTENANCE_WORKER_ENABLED: false,
      PROCESSING_POLL_INTERVAL_MS: 60_000,
      MAINTENANCE_POLL_INTERVAL_MS: 60_000,
    };
    const config = {
      getOrThrow: vi.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const runtime = new WorkerRuntimeService(
      processingQueue,
      processor,
      {} as MaintenanceQueueService,
      {} as MaintenanceProcessorService,
      config,
    );

    runtime.onModuleInit();
    await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
    const failure = fail.mock.calls[0]![1];
    expect(failure).toEqual(new Error('Processing job exceeded maximum attempts'));
    expect(recordFailure).toHaveBeenCalledWith(database, job, true, failure);
    expect(process).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    await runtime.onModuleDestroy();
  });
});
