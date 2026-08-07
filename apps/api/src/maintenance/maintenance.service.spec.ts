import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import type {
  ObjectStorageService,
  TenantStorageObject,
} from '../infrastructure/object-storage.service.js';
import type { PrismaService } from '../infrastructure/prisma.service.js';
import { MaintenanceService } from './maintenance.service.js';
import { StorageReconciliationService } from './storage-reconciliation.service.js';

type MockFunction = ReturnType<typeof vi.fn>;

interface TransactionMock {
  maintenanceJob: {
    findFirst: MockFunction;
    update: MockFunction;
  };
  deletionBatch: {
    updateMany: MockFunction;
  };
  auditEvent: {
    create: MockFunction;
  };
}

const actor: AuthenticatedUser = {
  userId: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-000000000002',
  sessionId: '00000000-0000-7000-8000-000000000003',
  authenticationMethods: ['password', 'totp'],
};

function createService() {
  const prisma = {
    maintenanceJob: {
      groupBy: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    deletionBatch: {
      groupBy: vi.fn(),
    },
    storageObject: {
      findMany: vi.fn(),
    },
    auditEvent: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const storage = {
    bucketName: vi.fn().mockReturnValue('dam-assets'),
    listTenantObjects: vi.fn(),
    objectExists: vi.fn(),
    removeObject: vi.fn(),
  };

  return {
    prisma,
    storage,
    service: new MaintenanceService(prisma as unknown as PrismaService),
    reconciliation: new StorageReconciliationService(
      prisma as unknown as PrismaService,
      storage as unknown as ObjectStorageService,
    ),
  };
}

async function* storedObjects(
  items: Array<{ objectKey: string; sizeBytes: bigint; lastModified: Date }>,
) {
  await Promise.resolve();
  yield* items;
}

function unavailableStoredObjects(): AsyncIterable<TenantStorageObject> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<TenantStorageObject>> {
          return Promise.reject(new Error('connection failed for secret internal object key'));
        },
      };
    },
  };
}

function createTransaction() {
  return {
    maintenanceJob: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    deletionBatch: {
      updateMany: vi.fn(),
    },
    auditEvent: {
      create: vi.fn(),
    },
  } satisfies TransactionMock;
}

function runTransactionsWith(
  prisma: ReturnType<typeof createService>['prisma'],
  database: TransactionMock,
) {
  prisma.$transaction.mockImplementation(
    async (operation: (transaction: TransactionMock) => Promise<unknown>) => operation(database),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MaintenanceService', () => {
  it('summarizes only the actor Tenant and returns its next pending due time', async () => {
    const { prisma, service } = createService();
    const nextDueAt = new Date('2026-08-08T01:00:00.000Z');
    prisma.maintenanceJob.groupBy.mockResolvedValue([
      { status: 'PENDING', _count: { _all: 3 } },
      { status: 'DEAD', _count: { _all: 1 } },
    ]);
    prisma.deletionBatch.groupBy.mockResolvedValue([{ status: 'RETAINED', _count: { _all: 2 } }]);
    prisma.maintenanceJob.findFirst.mockResolvedValue({ availableAt: nextDueAt });

    await expect(service.summary(actor)).resolves.toEqual({
      jobs: { PENDING: 3, DEAD: 1 },
      deletionBatches: { RETAINED: 2 },
      nextDueAt,
    });
    expect(prisma.maintenanceJob.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: actor.tenantId } }),
    );
    expect(prisma.deletionBatch.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: actor.tenantId } }),
    );
    expect(prisma.maintenanceJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: actor.tenantId, status: 'PENDING' },
      }),
    );
  });

  it('lists only the actor Tenant jobs with filters and cursor pagination', async () => {
    const { prisma, service } = createService();
    const cursor = '00000000-0000-7000-8000-000000000010';
    const first = { id: '00000000-0000-7000-8000-000000000011' };
    const second = { id: '00000000-0000-7000-8000-000000000012' };
    const lookahead = { id: '00000000-0000-7000-8000-000000000013' };
    prisma.maintenanceJob.findMany.mockResolvedValue([first, second, lookahead]);

    await expect(
      service.list(actor, {
        cursor,
        status: 'DEAD',
        jobType: 'PURGE_DELETION_BATCH',
        spaceId: '00000000-0000-7000-8000-000000000020',
        limit: 2,
      }),
    ).resolves.toEqual({ items: [first, second], nextCursor: second.id });
    expect(prisma.maintenanceJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: actor.tenantId,
          status: 'DEAD',
          jobType: 'PURGE_DELETION_BATCH',
          spaceId: '00000000-0000-7000-8000-000000000020',
        },
        cursor: { id: cursor },
        skip: 1,
        take: 3,
      }),
    );
  });

  it('reports missing and unknown Tenant objects without disclosing storage keys', async () => {
    const { prisma, reconciliation, storage } = createService();
    const missingKey = `tenants/${actor.tenantId}/spaces/space-a/objects/missing-secret-key`;
    const knownKey = `tenants/${actor.tenantId}/spaces/space-a/objects/known-secret-key`;
    const unknownKey = `tenants/${actor.tenantId}/spaces/space-b/objects/unknown-secret-key`;
    const databaseCreatedAt = new Date('2026-08-05T01:00:00.000Z');
    const lastModified = new Date('2026-08-06T02:00:00.000Z');
    prisma.storageObject.findMany
      .mockResolvedValueOnce([
        {
          id: '00000000-0000-7000-8000-000000000021',
          bucket: 'dam-assets',
          objectKey: missingKey,
          sizeBytes: 128n,
          createdAt: databaseCreatedAt,
        },
        {
          id: '00000000-0000-7000-8000-000000000022',
          bucket: 'dam-assets',
          objectKey: knownKey,
          sizeBytes: 256n,
          createdAt: databaseCreatedAt,
        },
      ])
      .mockResolvedValueOnce([{ objectKey: knownKey }]);
    storage.objectExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    storage.listTenantObjects.mockReturnValue(
      storedObjects([
        { objectKey: knownKey, sizeBytes: 256n, lastModified },
        { objectKey: unknownKey, sizeBytes: 512n, lastModified },
      ]),
    );
    prisma.auditEvent.create.mockResolvedValue({ id: 'audit-id' });

    const report = await reconciliation.report(
      actor,
      { limit: 50 },
      { ipAddress: '192.0.2.20', userAgent: 'reconciliation-test', requestId: 'request-2' },
    );

    expect(report.summary).toEqual({
      databaseObjects: 2,
      storageObjects: 2,
      missingObjects: 1,
      unknownObjects: 1,
    });
    expect(report.items).toHaveLength(2);
    const missingItem = report.items.find((item) => item.issueType === 'DATABASE_OBJECT_MISSING');
    const unknownItem = report.items.find((item) => item.issueType === 'STORAGE_OBJECT_UNKNOWN');
    expect(missingItem).toMatchObject({
      issueType: 'DATABASE_OBJECT_MISSING',
      storageObjectId: '00000000-0000-7000-8000-000000000021',
      expectedSizeBytes: '128',
    });
    expect(unknownItem).toMatchObject({
      issueType: 'STORAGE_OBJECT_UNKNOWN',
      observedSizeBytes: '512',
    });
    expect(
      unknownItem?.issueType === 'STORAGE_OBJECT_UNKNOWN' && unknownItem.objectFingerprint,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain(missingKey);
    expect(JSON.stringify(report)).not.toContain(knownKey);
    expect(JSON.stringify(report)).not.toContain(unknownKey);
    expect(storage.listTenantObjects).toHaveBeenCalledWith(actor.tenantId);
    expect(storage.removeObject).not.toHaveBeenCalled();
    expect(prisma.storageObject.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          OR: [
            {
              sourceVersions: {
                some: { asset: { node: { space: { tenantId: actor.tenantId } } } },
              },
            },
            {
              renditions: {
                some: {
                  assetVersion: {
                    asset: { node: { space: { tenantId: actor.tenantId } } },
                  },
                },
              },
            },
          ],
        },
      }),
    );
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'storage.reconciliation.read',
        resourceType: 'TENANT',
        resourceId: actor.tenantId,
        result: 'SUCCEEDED',
        ipAddress: '192.0.2.20',
        userAgent: 'reconciliation-test',
        requestId: 'request-2',
        details: {
          databaseObjects: 2,
          storageObjects: 2,
          missingObjects: 1,
          unknownObjects: 1,
          returnedItems: 2,
          hasNextPage: false,
        },
      },
    });
    expect(JSON.stringify(prisma.auditEvent.create.mock.calls)).not.toContain('secret-key');
  });

  it('paginates reconciliation issues with opaque cursors', async () => {
    const configure = () => {
      const context = createService();
      context.prisma.storageObject.findMany.mockResolvedValue([
        {
          id: '00000000-0000-7000-8000-000000000023',
          bucket: 'dam-assets',
          objectKey: 'tenants/tenant/objects/one',
          sizeBytes: 1n,
          createdAt: new Date('2026-08-05T01:00:00.000Z'),
        },
        {
          id: '00000000-0000-7000-8000-000000000024',
          bucket: 'dam-assets',
          objectKey: 'tenants/tenant/objects/two',
          sizeBytes: 2n,
          createdAt: new Date('2026-08-05T01:00:00.000Z'),
        },
      ]);
      context.storage.objectExists.mockResolvedValue(false);
      context.storage.listTenantObjects.mockReturnValue(storedObjects([]));
      context.prisma.auditEvent.create.mockResolvedValue({ id: 'audit-id' });
      return context;
    };
    const firstContext = configure();
    const first = await firstContext.reconciliation.report(actor, { limit: 1 }, {});
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^[a-f0-9]{64}$/);

    const secondContext = configure();
    const second = await secondContext.reconciliation.report(
      actor,
      { limit: 1, cursor: first.nextCursor! },
      {},
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id > first.items[0]!.id).toBe(true);
    expect(second.nextCursor).toBeNull();
  });

  it('returns a safe service error when object storage cannot be scanned', async () => {
    const { prisma, reconciliation, storage } = createService();
    prisma.storageObject.findMany.mockResolvedValue([]);
    storage.listTenantObjects.mockReturnValue(unavailableStoredObjects());

    await expect(reconciliation.report(actor, { limit: 50 }, {})).rejects.toMatchObject({
      status: 503,
      code: 'INTERNAL_ERROR',
      message: '对象存储暂时不可用，无法生成对账报告',
    });
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    expect(storage.removeObject).not.toHaveBeenCalled();
  });

  it('retries a DEAD purge job, synchronizes its batch, and records the audit event', async () => {
    vi.useFakeTimers();
    const retriedAt = new Date('2026-08-07T08:00:00.000Z');
    vi.setSystemTime(retriedAt);
    const { prisma, service } = createService();
    const database = createTransaction();
    runTransactionsWith(prisma, database);
    const jobId = '00000000-0000-7000-8000-000000000030';
    const batchId = '00000000-0000-7000-8000-000000000031';
    database.maintenanceJob.findFirst.mockResolvedValue({
      id: jobId,
      jobType: 'PURGE_DELETION_BATCH',
      targetId: batchId,
    });
    database.deletionBatch.updateMany.mockResolvedValue({ count: 1 });
    database.maintenanceJob.update.mockResolvedValue({ id: jobId });
    database.auditEvent.create.mockResolvedValue({ id: 'audit-id' });

    await expect(
      service.retry(actor, jobId, {
        ipAddress: '192.0.2.10',
        userAgent: 'maintenance-test',
        requestId: 'request-1',
      }),
    ).resolves.toEqual({ id: jobId, status: 'PENDING' });
    expect(database.maintenanceJob.findFirst).toHaveBeenCalledWith({
      where: { id: jobId, tenantId: actor.tenantId, status: 'DEAD' },
      select: { id: true, jobType: true, targetId: true },
    });
    expect(database.deletionBatch.updateMany).toHaveBeenCalledWith({
      where: { id: batchId, tenantId: actor.tenantId, status: 'FAILED' },
      data: { status: 'PURGE_REQUESTED', errorMessage: null },
    });
    expect(database.maintenanceJob.update).toHaveBeenCalledWith({
      where: { id: jobId },
      data: {
        status: 'PENDING',
        attempts: 0,
        availableAt: retriedAt,
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        completedAt: null,
        errorMessage: null,
      },
    });
    expect(database.auditEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'maintenance.job.retried',
        resourceType: 'MAINTENANCE_JOB',
        resourceId: jobId,
        result: 'SUCCEEDED',
        ipAddress: '192.0.2.10',
        userAgent: 'maintenance-test',
        requestId: 'request-1',
        details: { jobType: 'PURGE_DELETION_BATCH' },
      },
    });
  });

  it('rejects a job that is missing, belongs to another Tenant, or is not DEAD', async () => {
    const { prisma, service } = createService();
    const database = createTransaction();
    runTransactionsWith(prisma, database);
    const jobId = '00000000-0000-7000-8000-000000000040';
    database.maintenanceJob.findFirst.mockResolvedValue(null);

    await expect(service.retry(actor, jobId, {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
    });
    expect(database.maintenanceJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId, tenantId: actor.tenantId, status: 'DEAD' },
      }),
    );
    expect(database.deletionBatch.updateMany).not.toHaveBeenCalled();
    expect(database.maintenanceJob.update).not.toHaveBeenCalled();
    expect(database.auditEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a purge retry when its deletion batch is no longer FAILED', async () => {
    const { prisma, service } = createService();
    const database = createTransaction();
    runTransactionsWith(prisma, database);
    const jobId = '00000000-0000-7000-8000-000000000050';
    const batchId = '00000000-0000-7000-8000-000000000051';
    database.maintenanceJob.findFirst.mockResolvedValue({
      id: jobId,
      jobType: 'PURGE_DELETION_BATCH',
      targetId: batchId,
    });
    database.deletionBatch.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.retry(actor, jobId, {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
    });
    expect(database.deletionBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: batchId, tenantId: actor.tenantId, status: 'FAILED' },
      }),
    );
    expect(database.maintenanceJob.update).not.toHaveBeenCalled();
    expect(database.auditEvent.create).not.toHaveBeenCalled();
  });
});
