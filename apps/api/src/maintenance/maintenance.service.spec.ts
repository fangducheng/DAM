import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import type { PrismaService } from '../infrastructure/prisma.service.js';
import { MaintenanceService } from './maintenance.service.js';

const actor: AuthenticatedUser = {
  userId: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-000000000002',
  sessionId: '00000000-0000-7000-8000-000000000003',
  authenticationMethods: ['password', 'totp'],
};

const jobId = '00000000-0000-7000-8000-000000000010';
const runId = '00000000-0000-7000-8000-000000000011';

function createContext() {
  const database = {
    maintenanceJob: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    deletionBatch: { updateMany: vi.fn() },
    storageReconciliationRun: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    auditEvent: { create: vi.fn() },
  };
  const prisma = {
    maintenanceJob: {
      groupBy: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    deletionBatch: { groupBy: vi.fn() },
    $transaction: vi.fn(async (operation: (transaction: typeof database) => Promise<unknown>) =>
      operation(database),
    ),
  };
  return {
    database,
    prisma,
    service: new MaintenanceService(prisma as unknown as PrismaService),
  };
}

describe('MaintenanceService', () => {
  it('summarizes only the actor Tenant and returns its next pending due time', async () => {
    const { prisma, service } = createContext();
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
  });

  it('lists only the actor Tenant jobs with filters and cursor pagination', async () => {
    const { prisma, service } = createContext();
    const cursor = '00000000-0000-7000-8000-000000000020';
    const first = { id: '00000000-0000-7000-8000-000000000019' };
    const second = { id: '00000000-0000-7000-8000-000000000018' };
    const lookahead = { id: '00000000-0000-7000-8000-000000000017' };
    prisma.maintenanceJob.findMany.mockResolvedValue([first, second, lookahead]);

    await expect(
      service.list(actor, {
        cursor,
        status: 'DEAD',
        jobType: 'RECONCILE_STORAGE_STEP',
        limit: 2,
      }),
    ).resolves.toEqual({ items: [first, second], nextCursor: second.id });
    expect(prisma.maintenanceJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: actor.tenantId,
          status: 'DEAD',
          jobType: 'RECONCILE_STORAGE_STEP',
        },
        cursor: { id: cursor },
        skip: 1,
        take: 3,
      }),
    );
  });

  it('safely restores a failed reconciliation run before retrying its terminal job', async () => {
    const { database, service } = createContext();
    database.maintenanceJob.findFirst.mockResolvedValue({
      id: jobId,
      jobType: 'RECONCILE_STORAGE_STEP',
      targetId: runId,
      payload: { phase: 'DATABASE_SCAN', checkpointVersion: 2 },
    });
    database.storageReconciliationRun.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ phase: 'DATABASE_SCAN', checkpointVersion: 2 });
    database.storageReconciliationRun.updateMany.mockResolvedValue({ count: 1 });
    database.maintenanceJob.update.mockResolvedValue({ id: jobId });
    database.auditEvent.create.mockResolvedValue({ id: 'audit-id' });

    await expect(
      service.retry(actor, jobId, {
        ipAddress: '192.0.2.5',
        userAgent: 'unit-test',
        requestId: 'request-5',
      }),
    ).resolves.toEqual({ id: jobId, status: 'PENDING' });
    expect(database.storageReconciliationRun.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: actor.tenantId,
        status: { in: ['QUEUED', 'RUNNING', 'RETRYING'] },
      },
      select: { id: true },
    });
    expect(database.storageReconciliationRun.findFirst).toHaveBeenCalledWith({
      where: { id: runId, tenantId: actor.tenantId, status: 'FAILED' },
      select: { phase: true, checkpointVersion: true },
    });
    expect(database.storageReconciliationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: runId,
        tenantId: actor.tenantId,
        status: 'FAILED',
        phase: 'DATABASE_SCAN',
        checkpointVersion: 2,
      },
      data: {
        status: 'RETRYING',
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    const updateInput = database.maintenanceJob.update.mock.calls[0]?.[0] as
      { where: { id: string }; data: { status: string } } | undefined;
    expect(updateInput).toMatchObject({
      where: { id: jobId },
      data: { status: 'PENDING' },
    });
  });

  it('rejects reconciliation retry while another active run exists', async () => {
    const { database, service } = createContext();
    database.maintenanceJob.findFirst.mockResolvedValue({
      id: jobId,
      jobType: 'RECONCILE_STORAGE_STEP',
      targetId: runId,
      payload: { phase: 'DATABASE_SCAN', checkpointVersion: 2 },
    });
    database.storageReconciliationRun.findFirst.mockResolvedValue({ id: 'active-run' });

    await expect(service.retry(actor, jobId, {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(database.storageReconciliationRun.updateMany).not.toHaveBeenCalled();
    expect(database.maintenanceJob.update).not.toHaveBeenCalled();
  });

  it('rejects reconciliation retry when the failed target run is missing or cross-Tenant', async () => {
    const { database, service } = createContext();
    database.maintenanceJob.findFirst.mockResolvedValue({
      id: jobId,
      jobType: 'RECONCILE_STORAGE_STEP',
      targetId: runId,
      payload: { phase: 'DATABASE_SCAN', checkpointVersion: 2 },
    });
    database.storageReconciliationRun.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(service.retry(actor, jobId, {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(database.storageReconciliationRun.updateMany).not.toHaveBeenCalled();
    expect(database.maintenanceJob.update).not.toHaveBeenCalled();
    expect(database.auditEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'STORAGE_SCAN', checkpointVersion: 2 },
    { phase: 'DATABASE_SCAN', checkpointVersion: 1 },
  ])('rejects a stale reconciliation checkpoint payload %#', async (payload) => {
    const { database, service } = createContext();
    database.maintenanceJob.findFirst.mockResolvedValue({
      id: jobId,
      jobType: 'RECONCILE_STORAGE_STEP',
      targetId: runId,
      payload,
    });
    database.storageReconciliationRun.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ phase: 'DATABASE_SCAN', checkpointVersion: 2 });

    await expect(service.retry(actor, jobId, {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(database.storageReconciliationRun.updateMany).not.toHaveBeenCalled();
    expect(database.maintenanceJob.update).not.toHaveBeenCalled();
    expect(database.auditEvent.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid reconciliation checkpoint payload', async () => {
    const { database, service } = createContext();
    database.maintenanceJob.findFirst.mockResolvedValue({
      id: jobId,
      jobType: 'RECONCILE_STORAGE_STEP',
      targetId: runId,
      payload: null,
    });
    database.storageReconciliationRun.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ phase: 'DATABASE_SCAN', checkpointVersion: 2 });

    await expect(service.retry(actor, jobId, {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(database.storageReconciliationRun.updateMany).not.toHaveBeenCalled();
    expect(database.maintenanceJob.update).not.toHaveBeenCalled();
    expect(database.auditEvent.create).not.toHaveBeenCalled();
  });

  it('preserves purge batch synchronization when retrying purge jobs', async () => {
    const { database, service } = createContext();
    const batchId = '00000000-0000-7000-8000-000000000030';
    database.maintenanceJob.findFirst.mockResolvedValue({
      id: jobId,
      jobType: 'PURGE_DELETION_BATCH',
      targetId: batchId,
    });
    database.deletionBatch.updateMany.mockResolvedValue({ count: 1 });
    database.maintenanceJob.update.mockResolvedValue({ id: jobId });
    database.auditEvent.create.mockResolvedValue({ id: 'audit-id' });

    await expect(service.retry(actor, jobId, {})).resolves.toEqual({
      id: jobId,
      status: 'PENDING',
    });
    expect(database.deletionBatch.updateMany).toHaveBeenCalledWith({
      where: { id: batchId, tenantId: actor.tenantId, status: 'FAILED' },
      data: { status: 'PURGE_REQUESTED', errorMessage: null },
    });
  });

  it('rejects a job that is not a terminal job in the actor Tenant', async () => {
    const { database, service } = createContext();
    database.maintenanceJob.findFirst.mockResolvedValue(null);

    await expect(service.retry(actor, jobId, {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(database.maintenanceJob.update).not.toHaveBeenCalled();
  });
});
