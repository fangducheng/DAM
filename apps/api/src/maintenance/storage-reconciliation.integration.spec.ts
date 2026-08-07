import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { afterAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import { PrismaService } from '../infrastructure/prisma.service.js';
import { assertLocalIntegrationRunner } from '../testing/integration-test.guard.js';
import { StorageReconciliationService } from './storage-reconciliation.service.js';

const integrationEnabled = process.env['DAM_MAINTENANCE_INTEGRATION_TESTS'] === '1';
assertLocalIntegrationRunner(integrationEnabled);
const integration = integrationEnabled ? describe : describe.skip;

if (integrationEnabled) {
  const rootEnvPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
}

integration('persistent storage reconciliation API', () => {
  const prisma = new PrismaService();
  const reconciliation = new StorageReconciliationService(prisma);

  afterAll(async () => {
    // The isolated integration database retains the append-only requested audit and its fixtures.
    await prisma.$disconnect();
  });

  it('persists Tenant-isolated runs and immutable cursor-paginated issue snapshots', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const tenantA = await createTenantFixture(prisma, `reconcile-a-${suffix}`);
    const tenantB = await createTenantFixture(prisma, `reconcile-b-${suffix}`);
    const actorA = actorFor(tenantA);
    const actorB = actorFor(tenantB);
    const metadata = {
      ipAddress: '127.0.0.1',
      userAgent: 'persistent-reconciliation-integration',
      requestId: `reconciliation-${suffix}`,
    };

    const run = await reconciliation.createRun(actorA, {}, metadata);
    expect(run).toMatchObject({
      sourceRunId: null,
      status: 'QUEUED',
      phase: 'DATABASE_SCAN',
      databaseObjects: 0,
      storageObjects: 0,
      missingObjects: 0,
      unknownObjects: 0,
    });
    expect(JSON.stringify(run)).not.toContain('databaseCursor');
    expect(JSON.stringify(run)).not.toContain('storageCursor');
    expect(JSON.stringify(run)).not.toContain('tenantId');

    const firstJob = await prisma.maintenanceJob.findFirstOrThrow({
      where: {
        tenantId: tenantA.tenantId,
        targetId: run.id,
        jobType: 'RECONCILE_STORAGE_STEP',
      },
    });
    expect(firstJob).toMatchObject({
      idempotencyKey: `reconciliation:${run.id}:step:0`,
      payload: { phase: 'DATABASE_SCAN', checkpointVersion: 0 },
      status: 'PENDING',
    });

    await expect(reconciliation.createRun(actorA, {}, metadata)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(
      prisma.storageReconciliationRun.create({
        data: { tenantId: tenantA.tenantId, requestedById: tenantA.userId },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(reconciliation.getRun(actorB, run.id)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(
      reconciliation.createRun(actorB, { sourceRunId: run.id }, metadata),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const completedAt = new Date();
    await prisma.storageReconciliationRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        phase: 'COMPLETE',
        databaseObjects: 3,
        storageObjects: 4,
        missingObjects: 1,
        unknownObjects: 1,
        completedAt,
        databaseCursor: null,
        storageCursor: null,
      },
    });
    const missingKey = '1'.repeat(64);
    const unknownKey = '2'.repeat(64);
    const observedAt = new Date('2026-08-07T08:00:00.000Z');
    await prisma.storageReconciliationIssue.createMany({
      data: [
        {
          runId: run.id,
          tenantId: tenantA.tenantId,
          issueKey: missingKey,
          issueType: 'DATABASE_OBJECT_MISSING',
          storageObjectId: randomUUID(),
          expectedSizeBytes: 128n,
          databaseCreatedAt: observedAt,
        },
        {
          runId: run.id,
          tenantId: tenantA.tenantId,
          issueKey: unknownKey,
          issueType: 'STORAGE_OBJECT_UNKNOWN',
          objectFingerprint: unknownKey,
          observedSizeBytes: 256n,
          lastModifiedAt: observedAt,
        },
      ],
    });

    const firstPage = await reconciliation.listIssues(actorA, run.id, { limit: 1 });
    expect(firstPage).toMatchObject({
      runId: run.id,
      summary: {
        databaseObjects: 3,
        storageObjects: 4,
        missingObjects: 1,
        unknownObjects: 1,
      },
      items: [
        {
          id: missingKey,
          issueType: 'DATABASE_OBJECT_MISSING',
          expectedSizeBytes: '128',
        },
      ],
      nextCursor: missingKey,
    });
    const secondPage = await reconciliation.listIssues(actorA, run.id, {
      cursor: firstPage.nextCursor!,
      limit: 1,
    });
    expect(secondPage).toMatchObject({
      items: [
        {
          id: unknownKey,
          issueType: 'STORAGE_OBJECT_UNKNOWN',
          objectFingerprint: unknownKey,
          observedSizeBytes: '256',
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify({ firstPage, secondPage })).not.toContain(tenantA.tenantId);

    const requestedBeforeReads = await prisma.auditEvent.count({
      where: { tenantId: tenantA.tenantId, action: 'storage.reconciliation.requested' },
    });
    await reconciliation.listRuns(actorA, { limit: 50 });
    await reconciliation.getRun(actorA, run.id);
    await reconciliation.listIssues(actorA, run.id, { limit: 50 });
    const requestedAfterReads = await prisma.auditEvent.count({
      where: { tenantId: tenantA.tenantId, action: 'storage.reconciliation.requested' },
    });
    expect(requestedBeforeReads).toBe(1);
    expect(requestedAfterReads).toBe(requestedBeforeReads);

    const recheck = await reconciliation.createRun(actorA, { sourceRunId: run.id }, metadata);
    expect(recheck).toMatchObject({ sourceRunId: run.id, status: 'QUEUED' });
  }, 30_000);
});

async function createTenantFixture(prisma: PrismaService, code: string) {
  const tenant = await prisma.tenant.create({ data: { code, name: `${code} Tenant` } });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      loginName: `${code}-user`,
      email: `${code}@example.test`,
      displayName: `${code} User`,
      status: 'ACTIVE',
    },
  });
  return { tenantId: tenant.id, userId: user.id };
}

function actorFor(fixture: { tenantId: string; userId: string }): AuthenticatedUser {
  return {
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    sessionId: randomUUID(),
    authenticationMethods: ['password', 'totp'],
  };
}
