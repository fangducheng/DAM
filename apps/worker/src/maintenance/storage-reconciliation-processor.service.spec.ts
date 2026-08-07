import { createHash } from 'node:crypto';

import type { Prisma } from '@dam/database';
import { describe, expect, it, vi } from 'vitest';

import type { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import type { PrismaService } from '../infrastructure/prisma.service.js';
import type { ClaimedMaintenanceJob } from './maintenance-job.types.js';
import type { MaintenanceQueueService } from './maintenance-queue.service.js';
import {
  StorageReconciliationProcessorService,
  StorageReconciliationStepError,
} from './storage-reconciliation-processor.service.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const runId = '00000000-0000-7000-8000-000000000002';
const userId = '00000000-0000-7000-8000-000000000003';
const jobId = '00000000-0000-7000-8000-000000000004';
const cutoffAt = new Date('2026-08-07T08:00:00.000Z');

type Phase = 'DATABASE_SCAN' | 'STORAGE_SCAN' | 'FINALIZING' | 'COMPLETE';
type Status = 'QUEUED' | 'RUNNING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED';

interface RunFixture {
  id: string;
  tenantId: string;
  requestedById: string | null;
  status: Status;
  phase: Phase;
  checkpointVersion: number;
  databaseCursor: string | null;
  storageCursor: string | null;
  cutoffAt: Date;
  databaseObjects: number;
  storageObjects: number;
  missingObjects: number;
  unknownObjects: number;
  startedAt: Date | null;
}

function reconciliationRun(overrides: Partial<RunFixture> = {}): RunFixture {
  return {
    id: runId,
    tenantId,
    requestedById: userId,
    status: 'RUNNING',
    phase: 'DATABASE_SCAN',
    checkpointVersion: 0,
    databaseCursor: null,
    storageCursor: null,
    cutoffAt,
    databaseObjects: 0,
    storageObjects: 0,
    missingObjects: 0,
    unknownObjects: 0,
    startedAt: cutoffAt,
    ...overrides,
  };
}

function reconciliationJob(
  phase: Exclude<Phase, 'COMPLETE'> = 'DATABASE_SCAN',
  checkpointVersion = 0,
): ClaimedMaintenanceJob {
  return {
    id: jobId,
    idempotencyKey: `reconciliation:${runId}:step:${checkpointVersion}`,
    tenantId,
    spaceId: null,
    jobType: 'RECONCILE_STORAGE_STEP',
    targetId: runId,
    payload: { phase, checkpointVersion },
    attempts: 1,
    maxAttempts: 8,
    lockedBy: 'worker-test',
  };
}

function createContext() {
  const database = {
    storageReconciliationRun: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    storageReconciliationIssue: { createMany: vi.fn() },
    maintenanceJob: { createMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  const prisma = {
    storageReconciliationRun: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    storageObject: { findMany: vi.fn() },
    uploadSession: { findMany: vi.fn() },
    maintenanceJob: { findMany: vi.fn() },
    $transaction: vi.fn(async (operation: (transaction: typeof database) => Promise<unknown>) =>
      operation(database),
    ),
  };
  const storage = {
    bucketName: vi.fn(() => 'dam-assets'),
    objectExists: vi.fn(),
    listTenantObjectsPage: vi.fn(),
  };
  const queue = {
    renew: vi.fn().mockResolvedValue(new Date('2026-08-07T08:02:00.000Z')),
    assertActiveLease: vi.fn().mockResolvedValue(undefined),
  };
  database.storageReconciliationRun.updateMany.mockResolvedValue({ count: 1 });
  database.storageReconciliationIssue.createMany.mockResolvedValue({ count: 0 });
  database.maintenanceJob.createMany.mockResolvedValue({ count: 1 });
  database.auditEvent.create.mockResolvedValue({ id: 'audit-id' });
  prisma.storageReconciliationRun.updateMany.mockResolvedValue({ count: 1 });
  prisma.uploadSession.findMany.mockResolvedValue([]);
  prisma.maintenanceJob.findMany.mockResolvedValue([]);
  return {
    database,
    prisma,
    storage,
    queue,
    service: new StorageReconciliationProcessorService(
      prisma as unknown as PrismaService,
      storage as unknown as ObjectStorageService,
      queue as unknown as MaintenanceQueueService,
    ),
  };
}

describe('StorageReconciliationProcessorService', () => {
  it('treats missing and stale runs as idempotent no-ops', async () => {
    const { prisma, queue, service } = createContext();
    prisma.storageReconciliationRun.findFirst.mockResolvedValue(null);

    await expect(service.process(reconciliationJob())).resolves.toBeUndefined();

    expect(queue.renew).not.toHaveBeenCalled();
    expect(prisma.storageObject.findMany).not.toHaveBeenCalled();
  });

  it('starts a queued run and checkpoints an empty database page', async () => {
    const { database, prisma, service } = createContext();
    prisma.storageReconciliationRun.findFirst.mockResolvedValue(
      reconciliationRun({ status: 'QUEUED', startedAt: null }),
    );
    prisma.storageObject.findMany.mockResolvedValue([]);

    await service.process(reconciliationJob());

    const startInput = prisma.storageReconciliationRun.updateMany.mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    const startedAt = startInput?.data.startedAt;
    expect(startedAt).toBeInstanceOf(Date);
    expect(startInput).toEqual({
      where: {
        id: runId,
        tenantId,
        phase: 'DATABASE_SCAN',
        checkpointVersion: 0,
        status: 'QUEUED',
      },
      data: {
        status: 'RUNNING',
        startedAt,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    const checkpointInput = database.storageReconciliationRun.updateMany.mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    const lastCheckpointAt = checkpointInput?.data.lastCheckpointAt;
    expect(lastCheckpointAt).toBeInstanceOf(Date);
    expect(checkpointInput).toEqual({
      where: {
        id: runId,
        tenantId,
        status: 'RUNNING',
        phase: 'DATABASE_SCAN',
        checkpointVersion: 0,
      },
      data: {
        phase: 'STORAGE_SCAN',
        checkpointVersion: { increment: 1 },
        databaseCursor: null,
        storageCursor: null,
        databaseObjects: { increment: 0 },
        storageObjects: { increment: 0 },
        missingObjects: { increment: 0 },
        unknownObjects: { increment: 0 },
        lastCheckpointAt,
        errorCode: null,
        errorMessage: null,
      },
    });
    expect(database.maintenanceJob.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId,
          jobType: 'RECONCILE_STORAGE_STEP',
          idempotencyKey: `reconciliation:${runId}:step:1`,
          targetId: runId,
          payload: { phase: 'STORAGE_SCAN', checkpointVersion: 1 },
          maxAttempts: 8,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('records a missing database object without exposing its object key', async () => {
    const { database, prisma, storage, service } = createContext();
    const storageObjectId = '00000000-0000-7000-8000-000000000010';
    prisma.storageReconciliationRun.findFirst.mockResolvedValue(reconciliationRun());
    prisma.storageObject.findMany.mockResolvedValue([
      {
        id: storageObjectId,
        bucket: 'dam-assets',
        objectKey: `tenants/${tenantId}/objects/secret-key`,
        sizeBytes: 42n,
        createdAt: new Date('2026-08-07T07:00:00.000Z'),
      },
    ]);
    storage.objectExists.mockResolvedValue(false);

    await service.process(reconciliationJob());

    expect(storage.objectExists).toHaveBeenCalledWith(
      'dam-assets',
      `tenants/${tenantId}/objects/secret-key`,
    );
    const issueInput = database.storageReconciliationIssue.createMany.mock.calls[0]?.[0] as
      { data: Array<Record<string, unknown>>; skipDuplicates: boolean } | undefined;
    expect(issueInput?.skipDuplicates).toBe(true);
    expect(issueInput?.data).toHaveLength(1);
    expect(issueInput?.data[0]).toMatchObject({
      runId,
      tenantId,
      issueType: 'DATABASE_OBJECT_MISSING',
      storageObjectId,
      expectedSizeBytes: 42n,
    });
    expect(issueInput?.data[0]).not.toHaveProperty('objectKey');
  });

  it('uses only database evidence created by the cutoff when classifying storage objects', async () => {
    const { database, prisma, storage, service } = createContext();
    const registeredKey = `tenants/${tenantId}/objects/registered`;
    const uploadKey = `tenants/${tenantId}/uploads/uploading`;
    const deletingKey = `tenants/${tenantId}/objects/deleting`;
    const unknownKey = `tenants/${tenantId}/objects/unknown`;
    const afterCutoffKey = `tenants/${tenantId}/objects/newer`;
    prisma.storageReconciliationRun.findFirst.mockResolvedValue(
      reconciliationRun({ phase: 'STORAGE_SCAN', checkpointVersion: 3 }),
    );
    storage.listTenantObjectsPage.mockResolvedValue({
      items: [
        { objectKey: registeredKey, sizeBytes: 10n, lastModified: cutoffAt },
        { objectKey: uploadKey, sizeBytes: 20n, lastModified: cutoffAt },
        { objectKey: deletingKey, sizeBytes: 30n, lastModified: cutoffAt },
        { objectKey: unknownKey, sizeBytes: 40n, lastModified: cutoffAt },
        {
          objectKey: afterCutoffKey,
          sizeBytes: 50n,
          lastModified: new Date('2026-08-07T08:00:01.000Z'),
        },
      ],
      nextCursor: null,
    });
    prisma.storageObject.findMany.mockResolvedValue([{ objectKey: registeredKey }]);
    prisma.uploadSession.findMany.mockResolvedValue([{ objectKey: uploadKey }]);
    prisma.maintenanceJob.findMany.mockResolvedValue([
      { payload: { bucket: 'dam-assets', objectKey: deletingKey } },
    ]);

    await service.process(reconciliationJob('STORAGE_SCAN', 3));

    const eligibleKeys = [registeredKey, uploadKey, deletingKey, unknownKey];
    expect(prisma.storageObject.findMany).toHaveBeenCalledWith({
      where: {
        bucket: 'dam-assets',
        objectKey: { in: eligibleKeys },
        createdAt: { lte: cutoffAt },
      },
      select: { objectKey: true },
    });
    expect(prisma.uploadSession.findMany).toHaveBeenCalledWith({
      where: {
        space: { tenantId },
        status: { in: ['CREATED', 'UPLOADING'] },
        objectKey: { in: eligibleKeys },
        createdAt: { lte: cutoffAt },
      },
      select: { objectKey: true },
    });
    expect(prisma.maintenanceJob.findMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        jobType: 'DELETE_STORAGE_OBJECT',
        status: { in: ['PENDING', 'RUNNING', 'FAILED', 'DEAD'] },
        createdAt: { lte: cutoffAt },
        AND: [{ payload: { path: ['bucket'], equals: 'dam-assets' } }],
        OR: eligibleKeys.map((objectKey) => ({
          payload: { path: ['objectKey'], equals: objectKey },
        })),
      },
      select: { payload: true },
    });
    const issueInput = database.storageReconciliationIssue.createMany.mock.calls[0]?.[0] as
      { data: Array<Record<string, unknown>> } | undefined;
    expect(issueInput?.data).toHaveLength(1);
    expect(issueInput?.data[0]).toMatchObject({
      runId,
      tenantId,
      issueType: 'STORAGE_OBJECT_UNKNOWN',
      objectFingerprint: createHash('sha256')
        .update('STORAGE_OBJECT_UNKNOWN')
        .update('\0')
        .update(unknownKey)
        .digest('hex'),
      observedSizeBytes: 40n,
      lastModifiedAt: cutoffAt,
    });
    expect(issueInput?.data[0]).not.toHaveProperty('objectKey');
    const checkpointInput = database.storageReconciliationRun.updateMany.mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    expect(checkpointInput?.data).toMatchObject({
      phase: 'FINALIZING',
      storageObjects: { increment: 4 },
      unknownObjects: { increment: 1 },
    });
  });

  it('finalizes the current checkpoint and writes a summary-only audit event', async () => {
    const { database, prisma, service } = createContext();
    prisma.storageReconciliationRun.findFirst.mockResolvedValue(
      reconciliationRun({
        phase: 'FINALIZING',
        checkpointVersion: 7,
        databaseObjects: 12,
        storageObjects: 13,
        missingObjects: 1,
        unknownObjects: 2,
      }),
    );

    await service.process(reconciliationJob('FINALIZING', 7));

    const completionInput = database.storageReconciliationRun.updateMany.mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    const lastCheckpointAt = completionInput?.data.lastCheckpointAt;
    const completedAt = completionInput?.data.completedAt;
    expect(lastCheckpointAt).toBeInstanceOf(Date);
    expect(completedAt).toBeInstanceOf(Date);
    expect(completionInput).toEqual({
      where: {
        id: runId,
        tenantId,
        status: 'RUNNING',
        phase: 'FINALIZING',
        checkpointVersion: 7,
      },
      data: {
        status: 'SUCCEEDED',
        phase: 'COMPLETE',
        checkpointVersion: { increment: 1 },
        databaseCursor: null,
        storageCursor: null,
        lastCheckpointAt,
        completedAt,
        errorCode: null,
        errorMessage: null,
      },
    });
    expect(database.auditEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId,
        actorUserId: userId,
        action: 'storage.reconciliation.completed',
        resourceType: 'STORAGE_RECONCILIATION_RUN',
        resourceId: runId,
        result: 'SUCCEEDED',
        details: {
          databaseObjects: 12,
          storageObjects: 13,
          missingObjects: 1,
          unknownObjects: 2,
        },
      },
    });
  });

  it('normalizes invalid payloads and lease loss without provider details', async () => {
    const invalidContext = createContext();
    const invalidJob = { ...reconciliationJob(), payload: { phase: 'BAD' } };
    await expect(invalidContext.service.process(invalidJob)).rejects.toMatchObject({
      code: 'RECONCILIATION_STEP_FAILED',
      message: 'Storage reconciliation step failed',
    });

    const leaseContext = createContext();
    leaseContext.prisma.storageReconciliationRun.findFirst.mockResolvedValue(reconciliationRun());
    leaseContext.queue.renew.mockRejectedValue(new Error('Maintenance job lease was lost'));
    await expect(leaseContext.service.process(reconciliationJob())).rejects.toEqual(
      new StorageReconciliationStepError(
        'RECONCILIATION_LEASE_LOST',
        'Storage reconciliation lease was lost',
      ),
    );
  });

  it('records terminal failures with a safe error and summary-only audit event', async () => {
    const { database, service } = createContext();
    database.storageReconciliationRun.findUnique.mockResolvedValue({
      requestedById: userId,
      databaseObjects: 4,
      storageObjects: 5,
      missingObjects: 1,
      unknownObjects: 2,
    });

    await service.recordFailure(
      database as unknown as Prisma.TransactionClient,
      reconciliationJob('STORAGE_SCAN', 2),
      true,
      new Error('provider endpoint and secret details'),
    );

    const failureInput = database.storageReconciliationRun.updateMany.mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    const completedAt = failureInput?.data.completedAt;
    expect(completedAt).toBeInstanceOf(Date);
    expect(failureInput?.data).toMatchObject({
      status: 'FAILED',
      errorCode: 'RECONCILIATION_STEP_FAILED',
      errorMessage: 'Storage reconciliation step failed',
      completedAt,
    });
    expect(JSON.stringify(failureInput)).not.toContain('provider endpoint');
    expect(database.auditEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId,
        actorUserId: userId,
        action: 'storage.reconciliation.failed',
        resourceType: 'STORAGE_RECONCILIATION_RUN',
        resourceId: runId,
        result: 'FAILED',
        details: {
          maintenanceJobId: jobId,
          errorCode: 'RECONCILIATION_STEP_FAILED',
          phase: 'STORAGE_SCAN',
          databaseObjects: 4,
          storageObjects: 5,
          missingObjects: 1,
          unknownObjects: 2,
        },
      },
    });
  });

  it('records an invalid canonical job but ignores an invalid stale job', async () => {
    const canonical = createContext();
    canonical.database.storageReconciliationRun.findFirst.mockResolvedValue({
      phase: 'DATABASE_SCAN',
      checkpointVersion: 2,
    });
    const invalidCanonical = {
      ...reconciliationJob(),
      idempotencyKey: `reconciliation:${runId}:step:2`,
      payload: {},
    };

    await canonical.service.recordFailure(
      canonical.database as unknown as Prisma.TransactionClient,
      invalidCanonical,
      false,
      new Error('raw invalid payload'),
    );

    const canonicalInput = canonical.database.storageReconciliationRun.updateMany.mock
      .calls[0]?.[0] as { data: Record<string, unknown> } | undefined;
    expect(canonicalInput?.data).toMatchObject({
      status: 'RETRYING',
      errorCode: 'RECONCILIATION_INVALID_PAYLOAD',
      errorMessage: 'Storage reconciliation job payload is invalid',
      completedAt: null,
    });

    const stale = createContext();
    stale.database.storageReconciliationRun.findFirst.mockResolvedValue({
      phase: 'DATABASE_SCAN',
      checkpointVersion: 2,
    });
    await stale.service.recordFailure(
      stale.database as unknown as Prisma.TransactionClient,
      { ...invalidCanonical, idempotencyKey: `reconciliation:${runId}:step:1` },
      true,
      new Error('raw invalid payload'),
    );
    expect(stale.database.storageReconciliationRun.updateMany).not.toHaveBeenCalled();
    expect(stale.database.auditEvent.create).not.toHaveBeenCalled();
  });
});
