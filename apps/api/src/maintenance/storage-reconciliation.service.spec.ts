import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import type { PrismaService } from '../infrastructure/prisma.service.js';
import { StorageReconciliationService } from './storage-reconciliation.service.js';

const actor: AuthenticatedUser = {
  userId: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-000000000002',
  sessionId: '00000000-0000-7000-8000-000000000003',
  authenticationMethods: ['password', 'totp'],
};

const runId = '00000000-0000-7000-8000-000000000010';
const sourceRunId = '00000000-0000-7000-8000-000000000011';
const now = new Date('2026-08-07T09:00:00.000Z');

function safeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    sourceRunId: null,
    requestedBy: { id: actor.userId, displayName: '管理员' },
    status: 'QUEUED',
    phase: 'DATABASE_SCAN',
    databaseObjects: 0,
    storageObjects: 0,
    missingObjects: 0,
    unknownObjects: 0,
    cutoffAt: now,
    lastCheckpointAt: null,
    startedAt: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createContext() {
  const database = {
    storageReconciliationRun: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    maintenanceJob: { create: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  const prisma = {
    storageReconciliationRun: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    storageReconciliationIssue: { findMany: vi.fn() },
    $transaction: vi.fn(async (operation: (transaction: typeof database) => Promise<unknown>) =>
      operation(database),
    ),
  };
  return {
    database,
    prisma,
    service: new StorageReconciliationService(prisma as unknown as PrismaService),
  };
}

describe('StorageReconciliationService', () => {
  it('creates the run, first checkpoint job, and requested audit atomically', async () => {
    const { database, service } = createContext();
    const run = safeRun({ sourceRunId });
    database.storageReconciliationRun.findFirst
      .mockResolvedValueOnce({ id: sourceRunId })
      .mockResolvedValueOnce(null);
    database.storageReconciliationRun.create.mockResolvedValue(run);
    database.maintenanceJob.create.mockResolvedValue({ id: 'job-id' });
    database.auditEvent.create.mockResolvedValue({ id: 'audit-id' });

    await expect(
      service.createRun(
        actor,
        { sourceRunId },
        { ipAddress: '192.0.2.1', userAgent: 'unit-test', requestId: 'request-1' },
      ),
    ).resolves.toEqual(run);
    expect(database.storageReconciliationRun.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: sourceRunId, tenantId: actor.tenantId },
      select: { id: true },
    });
    expect(database.storageReconciliationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          tenantId: actor.tenantId,
          requestedById: actor.userId,
          sourceRunId,
        },
      }),
    );
    expect(database.maintenanceJob.create).toHaveBeenCalledWith({
      data: {
        tenantId: actor.tenantId,
        jobType: 'RECONCILE_STORAGE_STEP',
        idempotencyKey: `reconciliation:${runId}:step:0`,
        targetId: runId,
        payload: { phase: 'DATABASE_SCAN', checkpointVersion: 0 },
      },
      select: { id: true },
    });
    expect(database.auditEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'storage.reconciliation.requested',
        resourceType: 'STORAGE_RECONCILIATION_RUN',
        resourceId: runId,
        result: 'SUCCEEDED',
        ipAddress: '192.0.2.1',
        userAgent: 'unit-test',
        requestId: 'request-1',
        details: { sourceRunId },
      },
    });
  });

  it('hides a cross-Tenant source run and does not create a run', async () => {
    const { database, service } = createContext();
    database.storageReconciliationRun.findFirst.mockResolvedValue(null);

    await expect(service.createRun(actor, { sourceRunId }, {})).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(database.storageReconciliationRun.create).not.toHaveBeenCalled();
    expect(database.maintenanceJob.create).not.toHaveBeenCalled();
  });

  it('returns a stable conflict when the Tenant already has an active run', async () => {
    const { database, service } = createContext();
    database.storageReconciliationRun.findFirst.mockResolvedValue({ id: runId });

    await expect(service.createRun(actor, {}, {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
    });
    expect(database.storageReconciliationRun.create).not.toHaveBeenCalled();
  });

  it('lists only Tenant runs with stable descending UUID cursor pagination', async () => {
    const { prisma, service } = createContext();
    const first = safeRun({ id: '00000000-0000-7000-8000-000000000030' });
    const second = safeRun({ id: '00000000-0000-7000-8000-000000000020' });
    const lookahead = safeRun({ id: '00000000-0000-7000-8000-000000000010' });
    prisma.storageReconciliationRun.findMany.mockResolvedValue([first, second, lookahead]);

    await expect(
      service.listRuns(actor, { cursor: runId, status: 'SUCCEEDED', limit: 2 }),
    ).resolves.toEqual({ items: [first, second], nextCursor: second.id });
    expect(prisma.storageReconciliationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: actor.tenantId,
          status: 'SUCCEEDED',
          id: { lt: runId },
        },
        orderBy: { id: 'desc' },
        take: 3,
      }),
    );
  });

  it('hides a missing or cross-Tenant run', async () => {
    const { prisma, service } = createContext();
    prisma.storageReconciliationRun.findFirst.mockResolvedValue(null);

    await expect(service.getRun(actor, runId)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(prisma.storageReconciliationRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: runId, tenantId: actor.tenantId } }),
    );
  });

  it('paginates an immutable successful issue snapshot and serializes bigint sizes', async () => {
    const { prisma, service } = createContext();
    const completedAt = new Date('2026-08-07T09:30:00.000Z');
    prisma.storageReconciliationRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'SUCCEEDED',
      databaseObjects: 4,
      storageObjects: 5,
      missingObjects: 1,
      unknownObjects: 2,
      completedAt,
    });
    const firstKey = '1'.repeat(64);
    const secondKey = '2'.repeat(64);
    const lookaheadKey = '3'.repeat(64);
    prisma.storageReconciliationIssue.findMany.mockResolvedValue([
      {
        issueKey: firstKey,
        issueType: 'DATABASE_OBJECT_MISSING',
        storageObjectId: '00000000-0000-7000-8000-000000000041',
        objectFingerprint: null,
        expectedSizeBytes: 128n,
        observedSizeBytes: null,
        databaseCreatedAt: now,
        lastModifiedAt: null,
      },
      {
        issueKey: secondKey,
        issueType: 'STORAGE_OBJECT_UNKNOWN',
        storageObjectId: null,
        objectFingerprint: secondKey,
        expectedSizeBytes: null,
        observedSizeBytes: 256n,
        databaseCreatedAt: null,
        lastModifiedAt: now,
      },
      {
        issueKey: lookaheadKey,
        issueType: 'STORAGE_OBJECT_UNKNOWN',
        storageObjectId: null,
        objectFingerprint: lookaheadKey,
        expectedSizeBytes: null,
        observedSizeBytes: 512n,
        databaseCreatedAt: null,
        lastModifiedAt: now,
      },
    ]);

    const result = await service.listIssues(actor, runId, {
      cursor: '0'.repeat(64),
      limit: 2,
    });

    expect(result).toEqual({
      runId,
      generatedAt: completedAt,
      summary: {
        databaseObjects: 4,
        storageObjects: 5,
        missingObjects: 1,
        unknownObjects: 2,
      },
      items: [
        {
          id: firstKey,
          issueType: 'DATABASE_OBJECT_MISSING',
          storageObjectId: '00000000-0000-7000-8000-000000000041',
          expectedSizeBytes: '128',
          databaseCreatedAt: now,
        },
        {
          id: secondKey,
          issueType: 'STORAGE_OBJECT_UNKNOWN',
          objectFingerprint: secondKey,
          observedSizeBytes: '256',
          lastModifiedAt: now,
        },
      ],
      nextCursor: secondKey,
    });
    expect(prisma.storageReconciliationIssue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          runId,
          tenantId: actor.tenantId,
          issueKey: { gt: '0'.repeat(64) },
        },
        orderBy: { issueKey: 'asc' },
        take: 3,
      }),
    );
    expect(JSON.stringify(result)).not.toContain('tenantId');
  });

  it('does not expose issues before successful finalization', async () => {
    const { prisma, service } = createContext();
    prisma.storageReconciliationRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      databaseObjects: 0,
      storageObjects: 0,
      missingObjects: 0,
      unknownObjects: 0,
      completedAt: null,
    });

    await expect(service.listIssues(actor, runId, { limit: 50 })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
    });
    expect(prisma.storageReconciliationIssue.findMany).not.toHaveBeenCalled();
  });
});
