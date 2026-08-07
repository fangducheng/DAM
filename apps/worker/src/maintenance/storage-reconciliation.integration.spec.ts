import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { afterAll, describe, expect, it } from 'vitest';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { assertLocalIntegrationRunner } from '../testing/integration-test.guard.js';
import { MaintenanceQueueService } from './maintenance-queue.service.js';
import {
  StorageReconciliationProcessorService,
  StorageReconciliationStepError,
} from './storage-reconciliation-processor.service.js';

const integrationEnabled = process.env['DAM_RECONCILIATION_INTEGRATION_TESTS'] === '1';
assertLocalIntegrationRunner(integrationEnabled);
const integration = integrationEnabled ? describe : describe.skip;

if (integrationEnabled) {
  const rootEnvPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
}

integration('persistent storage reconciliation', () => {
  const prisma = new PrismaService();
  const endpoint = new URL(process.env['MINIO_ENDPOINT'] ?? 'http://localhost:9000');
  const bucket = process.env['MINIO_BUCKET'] ?? 'dam-assets';
  const accessKey = process.env['MINIO_ACCESS_KEY'] ?? 'dam_local_admin';
  const secretKey = process.env['MINIO_SECRET_KEY'] ?? 'dam_local_password';
  const minio = new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || 9000),
    useSSL: endpoint.protocol === 'https:',
    accessKey,
    secretKey,
  });
  const objectKeys = new Set<string>();

  afterAll(async () => {
    await Promise.all(
      [...objectKeys].map(async (objectKey) => {
        try {
          await minio.removeObject(bucket, objectKey);
        } catch {
          // A failed assertion must not prevent cleanup of the remaining fixture objects.
        }
      }),
    );
    await prisma.$disconnect();
  });

  it('finds missing and unknown objects without exposing or deleting storage keys', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tenant = await prisma.tenant.create({
      data: { code: `reconcile-${suffix}`, name: 'Reconciliation Integration' },
    });
    const otherTenant = await prisma.tenant.create({
      data: { code: `reconcile-other-${suffix}`, name: 'Other Reconciliation Tenant' },
    });
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `reconcile-${suffix}`,
        email: `reconcile-${suffix}@example.test`,
        displayName: 'Reconciliation User',
        status: 'ACTIVE',
      },
    });
    const space = await prisma.space.create({
      data: {
        tenantId: tenant.id,
        ownerType: 'TENANT',
        code: `reconcile-${suffix}`,
        name: 'Reconciliation Space',
        createdById: user.id,
      },
    });
    const prefix = `tenants/${tenant.id}/integration/reconciliation/${suffix}`;
    const keys = {
      registered: `${prefix}/registered.bin`,
      activeUpload: `${prefix}/active-upload.bin`,
      pendingDeletion: `${prefix}/pending-deletion.bin`,
      completedUpload: `${prefix}/completed-upload.bin`,
      unknown: `${prefix}/unknown.bin`,
      otherTenant: `tenants/${otherTenant.id}/integration/reconciliation/${suffix}/unknown.bin`,
    };
    const payload = Buffer.from(`reconciliation-${suffix}`, 'utf8');

    for (const objectKey of Object.values(keys)) {
      objectKeys.add(objectKey);
      await minio.putObject(bucket, objectKey, payload, payload.length, {
        'Content-Type': 'application/octet-stream',
      });
    }

    const registered = await prisma.storageObject.create({
      data: {
        bucket,
        objectKey: keys.registered,
        checksumSha256: '1'.repeat(64),
        sizeBytes: payload.length,
        referenceCount: 0,
      },
    });
    const missing = await prisma.storageObject.create({
      data: {
        bucket,
        objectKey: `${prefix}/missing.bin`,
        checksumSha256: '2'.repeat(64),
        sizeBytes: payload.length,
        referenceCount: 0,
      },
    });
    await prisma.uploadSession.createMany({
      data: [
        {
          spaceId: space.id,
          initiatedById: user.id,
          uploadId: `active-${suffix}`,
          objectKey: keys.activeUpload,
          fileName: 'active-upload.bin',
          sizeBytes: payload.length,
          mimeType: 'application/octet-stream',
          status: 'UPLOADING',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          spaceId: space.id,
          initiatedById: user.id,
          uploadId: `completed-${suffix}`,
          objectKey: keys.completedUpload,
          fileName: 'completed-upload.bin',
          sizeBytes: payload.length,
          mimeType: 'application/octet-stream',
          status: 'COMPLETED',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });
    await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        spaceId: space.id,
        jobType: 'DELETE_STORAGE_OBJECT',
        idempotencyKey: `integration:${suffix}:pending-delete`,
        targetId: randomUUID(),
        payload: { bucket, objectKey: keys.pendingDeletion },
        availableAt: new Date('2100-01-01T00:00:00.000Z'),
      },
    });

    const run = await prisma.storageReconciliationRun.create({
      data: {
        tenantId: tenant.id,
        requestedById: user.id,
        cutoffAt: new Date(Date.now() + 5_000),
      },
    });
    await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        jobType: 'RECONCILE_STORAGE_STEP',
        idempotencyKey: `reconciliation:${run.id}:step:0`,
        targetId: run.id,
        payload: { phase: 'DATABASE_SCAN', checkpointVersion: 0 },
        maxAttempts: 3,
        availableAt: new Date('1800-01-01T00:00:00.000Z'),
      },
    });

    const config = new ConfigService({
      MAINTENANCE_WORKER_ID: `reconciliation-${suffix}`,
      MAINTENANCE_LEASE_SECONDS: 60,
      MAINTENANCE_RETRY_BASE_SECONDS: 1,
      MINIO_ENDPOINT: endpoint.toString(),
      MINIO_ACCESS_KEY: accessKey,
      MINIO_SECRET_KEY: secretKey,
      MINIO_BUCKET: bucket,
    });
    const queue = new MaintenanceQueueService(prisma, config);
    const processor = new StorageReconciliationProcessorService(
      prisma,
      new ObjectStorageService(config),
      queue,
    );

    for (let step = 0; step < 6; step += 1) {
      const current = await prisma.storageReconciliationRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { status: true },
      });
      if (current.status === 'SUCCEEDED') break;
      const expectedJob = await prisma.maintenanceJob.findFirstOrThrow({
        where: {
          tenantId: tenant.id,
          jobType: 'RECONCILE_STORAGE_STEP',
          targetId: run.id,
          status: 'PENDING',
        },
        select: { id: true },
      });
      await prisma.maintenanceJob.update({
        where: { id: expectedJob.id },
        data: { availableAt: new Date(Date.UTC(1800, 0, 1, 0, 0, step)) },
      });
      const job = await queue.claim();
      expect(job).toMatchObject({
        id: expectedJob.id,
        tenantId: tenant.id,
        jobType: 'RECONCILE_STORAGE_STEP',
        targetId: run.id,
      });
      await processor.process(job!);
      if (step === 0) {
        await prisma.maintenanceJob.update({
          where: { id: job!.id },
          data: { leaseExpiresAt: new Date(0) },
        });
        const recoveryQueue = new MaintenanceQueueService(prisma, config);
        const recovered = await recoveryQueue.claim();
        expect(recovered).toMatchObject({
          id: job!.id,
          attempts: 2,
          idempotencyKey: `reconciliation:${run.id}:step:0`,
        });
        expect(recovered!.lockedBy).not.toBe(job!.lockedBy);
        await processor.process(recovered!);
        await recoveryQueue.complete(recovered!.id);
      } else {
        await queue.complete(job!.id);
      }
    }

    const completed = await prisma.storageReconciliationRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(completed).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'COMPLETE',
      databaseCursor: null,
      storageCursor: null,
      databaseObjects: 2,
      storageObjects: 5,
      missingObjects: 1,
      unknownObjects: 2,
      errorCode: null,
      errorMessage: null,
    });

    const issues = await prisma.storageReconciliationIssue.findMany({
      where: { runId: run.id, tenantId: tenant.id },
      orderBy: [{ issueType: 'asc' }, { issueKey: 'asc' }],
    });
    expect(issues).toHaveLength(3);
    expect(issues.filter(({ issueType }) => issueType === 'DATABASE_OBJECT_MISSING')).toEqual([
      expect.objectContaining({
        tenantId: tenant.id,
        storageObjectId: missing.id,
        objectFingerprint: null,
        expectedSizeBytes: BigInt(payload.length),
        observedSizeBytes: null,
      }),
    ]);
    expect(issues.filter(({ issueType }) => issueType === 'STORAGE_OBJECT_UNKNOWN')).toEqual([
      expect.objectContaining({
        tenantId: tenant.id,
        storageObjectId: null,
        expectedSizeBytes: null,
        observedSizeBytes: BigInt(payload.length),
      }),
      expect.objectContaining({
        tenantId: tenant.id,
        storageObjectId: null,
        expectedSizeBytes: null,
        observedSizeBytes: BigInt(payload.length),
      }),
    ]);
    expect(issues.some(({ storageObjectId }) => storageObjectId === registered.id)).toBe(false);

    const audit = await prisma.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        action: 'storage.reconciliation.completed',
        resourceId: run.id,
      },
      select: { action: true, resourceId: true, result: true, details: true },
    });
    expect(audit).toEqual([
      expect.objectContaining({
        result: 'SUCCEEDED',
        details: {
          databaseObjects: 2,
          storageObjects: 5,
          missingObjects: 1,
          unknownObjects: 2,
        },
      }),
    ]);
    const reconciliationJobs = await prisma.maintenanceJob.findMany({
      where: { tenantId: tenant.id, jobType: 'RECONCILE_STORAGE_STEP', targetId: run.id },
      select: {
        idempotencyKey: true,
        payload: true,
        status: true,
        attempts: true,
        errorMessage: true,
      },
    });
    expect(reconciliationJobs).toHaveLength(3);
    expect(reconciliationJobs.every(({ errorMessage }) => errorMessage === null)).toBe(true);
    expect(reconciliationJobs).toContainEqual(
      expect.objectContaining({
        idempotencyKey: `reconciliation:${run.id}:step:0`,
        status: 'SUCCEEDED',
        attempts: 2,
      }),
    );

    const persistedSummary = JSON.stringify(
      { completed, issues, audit, reconciliationJobs },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    for (const secret of [bucket, accessKey, secretKey, ...Object.values(keys)]) {
      expect(persistedSummary).not.toContain(secret);
    }
    for (const objectKey of Object.values(keys)) {
      await expect(minio.statObject(bucket, objectKey)).resolves.toBeTruthy();
    }
  }, 60_000);

  it('persists a terminal step failure without losing its checkpoint or exposing provider details', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tenant = await prisma.tenant.create({
      data: { code: `reconcile-fail-${suffix}`, name: 'Reconciliation Failure Integration' },
    });
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `reconcile-fail-${suffix}`,
        email: `reconcile-fail-${suffix}@example.test`,
        displayName: 'Reconciliation Failure User',
        status: 'ACTIVE',
      },
    });
    const databaseCursor = randomUUID();
    const storageCursor = `tenants/${tenant.id}/integration/reconciliation/${suffix}/cursor.bin`;
    const run = await prisma.storageReconciliationRun.create({
      data: {
        tenantId: tenant.id,
        requestedById: user.id,
        status: 'RUNNING',
        phase: 'STORAGE_SCAN',
        checkpointVersion: 4,
        databaseCursor,
        storageCursor,
        databaseObjects: 7,
        storageObjects: 5,
        missingObjects: 1,
        unknownObjects: 2,
        startedAt: new Date(),
        lastCheckpointAt: new Date(),
      },
    });
    const createdJob = await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        jobType: 'RECONCILE_STORAGE_STEP',
        idempotencyKey: `reconciliation:${run.id}:step:4`,
        targetId: run.id,
        payload: { phase: 'STORAGE_SCAN', checkpointVersion: 4 },
        maxAttempts: 1,
        availableAt: new Date('1700-01-01T00:00:00.000Z'),
      },
    });
    const config = new ConfigService({
      MAINTENANCE_WORKER_ID: `reconciliation-failure-${suffix}`,
      MAINTENANCE_LEASE_SECONDS: 60,
      MAINTENANCE_RETRY_BASE_SECONDS: 1,
      MINIO_ENDPOINT: endpoint.toString(),
      MINIO_ACCESS_KEY: accessKey,
      MINIO_SECRET_KEY: secretKey,
      MINIO_BUCKET: bucket,
    });
    const queue = new MaintenanceQueueService(prisma, config);
    const processor = new StorageReconciliationProcessorService(
      prisma,
      new ObjectStorageService(config),
      queue,
    );
    const job = await queue.claim();
    expect(job).toMatchObject({
      id: createdJob.id,
      idempotencyKey: `reconciliation:${run.id}:step:4`,
      attempts: 1,
      maxAttempts: 1,
    });
    const rawProviderError = new Error(`provider failed for ${storageCursor} in ${bucket}`);
    const safeFailure = new StorageReconciliationStepError(
      'RECONCILIATION_STEP_FAILED',
      'Storage reconciliation step failed',
    );

    await expect(
      queue.fail(job!, safeFailure, (database, terminal) =>
        processor.recordFailure(database, job!, terminal, safeFailure),
      ),
    ).resolves.toBe('DEAD');

    const failedJob = await prisma.maintenanceJob.findUniqueOrThrow({
      where: { id: createdJob.id },
    });
    expect(failedJob).toMatchObject({
      status: 'DEAD',
      attempts: 1,
      errorMessage: safeFailure.message,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
    });
    expect(failedJob.completedAt).toBeInstanceOf(Date);

    const failedRun = await prisma.storageReconciliationRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(failedRun).toMatchObject({
      status: 'FAILED',
      phase: 'STORAGE_SCAN',
      checkpointVersion: 4,
      databaseCursor,
      storageCursor,
      errorCode: 'RECONCILIATION_STEP_FAILED',
      errorMessage: safeFailure.message,
    });
    expect(failedRun.completedAt).toBeInstanceOf(Date);

    const failedAudit = await prisma.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        action: 'storage.reconciliation.failed',
        resourceId: run.id,
      },
      select: { result: true, details: true },
    });
    expect(failedAudit).toEqual([
      {
        result: 'FAILED',
        details: {
          maintenanceJobId: createdJob.id,
          errorCode: 'RECONCILIATION_STEP_FAILED',
          phase: 'STORAGE_SCAN',
          databaseObjects: 7,
          storageObjects: 5,
          missingObjects: 1,
          unknownObjects: 2,
        },
      },
    ]);
    const persistedFailure = JSON.stringify({
      jobError: failedJob.errorMessage,
      runError: failedRun.errorMessage,
      failedAudit,
    });
    expect(persistedFailure).not.toContain(rawProviderError.message);
    expect(persistedFailure).not.toContain(storageCursor);
    expect(persistedFailure).not.toContain(bucket);
    expect(persistedFailure).not.toContain(accessKey);
    expect(persistedFailure).not.toContain(secretKey);
  }, 30_000);
});
