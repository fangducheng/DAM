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
});
