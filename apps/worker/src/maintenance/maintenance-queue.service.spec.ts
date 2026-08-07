import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../infrastructure/prisma.service.js';
import { MaintenanceQueueService } from './maintenance-queue.service.js';

function createQueue() {
  const prisma = {
    maintenanceJob: { updateMany: vi.fn() },
  };
  const config = {
    getOrThrow: vi.fn((key: string) => {
      const values: Record<string, string | number> = {
        MAINTENANCE_WORKER_ID: 'worker-test',
        MAINTENANCE_LEASE_SECONDS: 120,
        MAINTENANCE_RETRY_BASE_SECONDS: 5,
      };
      return values[key];
    }),
  } as unknown as ConfigService;
  return {
    prisma,
    queue: new MaintenanceQueueService(prisma as unknown as PrismaService, config),
  };
}

describe('MaintenanceQueueService lease renewal', () => {
  it('renews only an active lease owned by the claiming Worker', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-07T03:00:00.000Z');
    vi.setSystemTime(now);
    const { prisma, queue } = createQueue();
    prisma.maintenanceJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(queue.renew({ id: 'job-id', lockedBy: 'worker-id' })).resolves.toEqual(
      new Date('2026-08-07T03:02:00.000Z'),
    );
    expect(prisma.maintenanceJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-id',
        status: 'RUNNING',
        lockedBy: 'worker-id',
        leaseExpiresAt: { gt: now },
      },
      data: { leaseExpiresAt: new Date('2026-08-07T03:02:00.000Z') },
    });
    vi.useRealTimers();
  });

  it('rejects renewal after ownership or the active lease is lost', async () => {
    const { prisma, queue } = createQueue();
    prisma.maintenanceJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(queue.renew({ id: 'job-id', lockedBy: 'stale-worker' })).rejects.toThrow(
      'Maintenance job job-id lease was lost',
    );
  });
});
