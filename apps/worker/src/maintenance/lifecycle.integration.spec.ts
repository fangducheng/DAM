import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { assertLocalIntegrationRunner } from '../testing/integration-test.guard.js';
import type { ClaimedMaintenanceJob } from './maintenance-job.types.js';
import { MaintenanceProcessorService } from './maintenance-processor.service.js';
import { MaintenanceQueueService } from './maintenance-queue.service.js';

const integrationEnabled = process.env['DAM_LIFECYCLE_INTEGRATION_TESTS'] === '1';
assertLocalIntegrationRunner(integrationEnabled);
const integration = integrationEnabled ? describe : describe.skip;

if (integrationEnabled) {
  const rootEnvPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(rootEnvPath)) {
    process.loadEnvFile(rootEnvPath);
  }
}

integration('lifecycle maintenance', () => {
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
  const config = new ConfigService({
    MINIO_ENDPOINT: endpoint.toString(),
    MINIO_ACCESS_KEY: accessKey,
    MINIO_SECRET_KEY: secretKey,
    MINIO_BUCKET: bucket,
    NOTIFICATION_READ_RETENTION_DAYS: 180,
    NOTIFICATION_ARCHIVED_RETENTION_DAYS: 90,
    COMPLETED_JOB_RETENTION_DAYS: 30,
  });
  const storage = new ObjectStorageService(config);
  const processor = new MaintenanceProcessorService(prisma, storage, config);
  const objectKeys = new Set<string>();

  afterAll(async () => {
    await Promise.all(
      [...objectKeys].map(async (objectKey) => {
        try {
          await minio.removeObject(bucket, objectKey);
        } catch {
          // The purge path normally removes it first.
        }
      }),
    );
    await prisma.$disconnect();
  });

  it('purges one batch atomically and deletes its unreferenced MinIO object', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const payload = Buffer.from('lifecycle integration payload', 'utf8');
    const objectKey = `integration/lifecycle/${suffix}.txt`;
    objectKeys.add(objectKey);
    await minio.putObject(bucket, objectKey, payload, payload.length, {
      'Content-Type': 'text/plain',
    });

    const tenant = await prisma.tenant.create({
      data: { code: `lifecycle-${suffix}`, name: 'Lifecycle Integration' },
    });
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `lifecycle-${suffix}`,
        email: `lifecycle-${suffix}@example.test`,
        displayName: 'Lifecycle User',
        status: 'ACTIVE',
      },
    });
    const space = await prisma.space.create({
      data: {
        tenantId: tenant.id,
        ownerType: 'TENANT',
        code: `lifecycle-${suffix}`,
        name: 'Lifecycle Space',
        createdById: user.id,
        quotaBytes: BigInt(payload.length * 10),
        usedBytes: BigInt(payload.length),
      },
    });
    const root = await prisma.resourceNode.create({
      data: {
        spaceId: space.id,
        nodeType: 'FOLDER',
        name: 'Root',
        normalizedName: 'root',
        isRoot: true,
        createdById: user.id,
      },
    });
    const node = await prisma.resourceNode.create({
      data: {
        spaceId: space.id,
        parentId: root.id,
        nodeType: 'ASSET',
        name: 'Agreement.txt',
        normalizedName: 'agreement.txt',
        createdById: user.id,
      },
    });
    await prisma.resourceClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: node.id, descendantId: node.id, depth: 0 },
        { ancestorId: root.id, descendantId: node.id, depth: 1 },
      ],
    });
    const stored = await prisma.storageObject.create({
      data: {
        bucket,
        objectKey,
        checksumSha256: '0'.repeat(64),
        sizeBytes: payload.length,
        referenceCount: 2,
      },
    });
    const asset = await prisma.asset.create({
      data: {
        nodeId: node.id,
        originalFileName: node.name,
        mimeType: 'text/plain',
      },
    });
    const version = await prisma.assetVersion.create({
      data: {
        assetId: asset.id,
        versionNumber: 1,
        storageObjectId: stored.id,
        status: 'AVAILABLE',
        scanStatus: 'SKIPPED',
        checksumSha256: '0'.repeat(64),
        sizeBytes: payload.length,
        mimeType: 'text/plain',
        createdById: user.id,
      },
    });
    await prisma.asset.update({ where: { id: asset.id }, data: { currentVersionId: version.id } });
    await prisma.assetRendition.create({
      data: {
        assetVersionId: version.id,
        storageObjectId: stored.id,
        type: 'BROWSER_PREVIEW',
        variant: 'original',
        status: 'AVAILABLE',
      },
    });

    const batch = await prisma.deletionBatch.create({
      data: {
        tenantId: tenant.id,
        spaceId: space.id,
        rootNodeId: node.id,
        rootName: node.name,
        rootType: 'ASSET',
        deletedById: user.id,
        deletedAt: new Date(Date.now() - 31 * 86_400_000),
        purgeAt: new Date(Date.now() - 86_400_000),
        itemCount: 1,
        sourceBytes: payload.length,
      },
    });
    await prisma.resourceNode.update({
      where: { id: node.id },
      data: { status: 'DELETED', deletedAt: batch.deletedAt, deletionBatchId: batch.id },
    });
    const lockedBy = `integration-${suffix}`;
    const purgeJob = await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        spaceId: space.id,
        jobType: 'PURGE_DELETION_BATCH',
        idempotencyKey: `integration:${suffix}:purge`,
        targetId: batch.id,
        status: 'RUNNING',
        attempts: 1,
        lockedAt: new Date(),
        lockedBy,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    });
    await processor.process(claimed(purgeJob, lockedBy));

    expect(await prisma.resourceNode.findUnique({ where: { id: node.id } })).toBeNull();
    expect(await prisma.space.findUniqueOrThrow({ where: { id: space.id } })).toMatchObject({
      usedBytes: 0n,
    });
    expect(await prisma.deletionBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject(
      {
        status: 'PURGED',
        releasedBytes: BigInt(payload.length),
      },
    );
    expect(await prisma.storageObject.findUnique({ where: { id: stored.id } })).toBeNull();

    const deletionJob = await prisma.maintenanceJob.findUniqueOrThrow({
      where: { idempotencyKey: `storage:${stored.id}:delete` },
    });
    await prisma.maintenanceJob.update({
      where: { id: deletionJob.id },
      data: {
        status: 'RUNNING',
        attempts: 1,
        lockedAt: new Date(),
        lockedBy,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    });
    await processor.process(claimed({ ...deletionJob, attempts: 1 }, lockedBy));
    await expect(minio.statObject(bucket, objectKey)).rejects.toBeTruthy();
    objectKeys.delete(objectKey);
  }, 30_000);

  it('expires uploads, emits one warning, and prunes only eligible retained records', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const tenant = await prisma.tenant.create({
      data: { code: `retention-${suffix}`, name: 'Retention Integration' },
    });
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `retention-${suffix}`,
        email: `retention-${suffix}@example.test`,
        displayName: 'Retention User',
        status: 'ACTIVE',
      },
    });
    const space = await prisma.space.create({
      data: {
        tenantId: tenant.id,
        ownerType: 'TENANT',
        code: `retention-${suffix}`,
        name: 'Retention Space',
        createdById: user.id,
        quotaBytes: 1024n,
      },
    });
    const lockedBy = `retention-${suffix}`;
    const leaseExpiresAt = new Date(Date.now() + 120_000);
    const upload = await prisma.uploadSession.create({
      data: {
        spaceId: space.id,
        initiatedById: user.id,
        uploadId: `missing-${suffix}`,
        objectKey: `integration/expired/${suffix}.bin`,
        fileName: 'expired.bin',
        sizeBytes: 16n,
        mimeType: 'application/octet-stream',
        status: 'UPLOADING',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const expirationJob = await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        spaceId: space.id,
        jobType: 'EXPIRE_UPLOAD_SESSION',
        idempotencyKey: `integration:${suffix}:expire`,
        targetId: upload.id,
        status: 'RUNNING',
        attempts: 1,
        lockedAt: new Date(),
        lockedBy,
        leaseExpiresAt,
      },
    });
    const abort = vi.spyOn(storage, 'abortMultipart').mockResolvedValueOnce(undefined);
    await processor.process(claimed(expirationJob, lockedBy));
    expect(abort).toHaveBeenCalledWith(upload.objectKey, upload.uploadId);
    abort.mockRestore();
    expect(
      await prisma.uploadSession.findUniqueOrThrow({ where: { id: upload.id } }),
    ).toMatchObject({ status: 'EXPIRED' });
    expect(
      await prisma.auditEvent.count({
        where: { tenantId: tenant.id, action: 'upload.expired', resourceId: upload.id },
      }),
    ).toBe(1);

    const batch = await prisma.deletionBatch.create({
      data: {
        tenantId: tenant.id,
        spaceId: space.id,
        rootNodeId: randomUUID(),
        rootName: 'Old contract.pdf',
        rootType: 'ASSET',
        deletedById: user.id,
        deletedAt: new Date(Date.now() - 23 * 86_400_000),
        purgeAt: new Date(Date.now() + 7 * 86_400_000),
        itemCount: 1,
      },
    });
    const warningJob = await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        spaceId: space.id,
        jobType: 'RETENTION_WARNING',
        idempotencyKey: `integration:${suffix}:warning`,
        targetId: batch.id,
        payload: { daysRemaining: 7 },
        status: 'RUNNING',
        attempts: 1,
        lockedAt: new Date(),
        lockedBy,
        leaseExpiresAt,
      },
    });
    await processor.process(claimed(warningJob, lockedBy));
    await processor.process(claimed(warningJob, lockedBy));
    expect(
      await prisma.notification.count({
        where: { userId: user.id, type: 'resource.retention.warning' },
      }),
    ).toBe(1);

    const dayMs = 86_400_000;
    const oldRead = await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'retention.old-read',
        payload: {},
        status: 'READ',
        readAt: new Date(Date.now() - 181 * dayMs),
      },
    });
    const recentRead = await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'retention.recent-read',
        payload: {},
        status: 'READ',
        readAt: new Date(Date.now() - 10 * dayMs),
      },
    });
    const oldArchived = await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'retention.old-archived',
        payload: {},
        status: 'ARCHIVED',
        archivedAt: new Date(Date.now() - 91 * dayMs),
      },
    });
    const unread = await prisma.notification.create({
      data: { userId: user.id, type: 'retention.unread', payload: {} },
    });
    const notificationPruneJob = await runningJob(
      prisma,
      tenant.id,
      `integration:${suffix}:prune-notifications`,
      'PRUNE_NOTIFICATIONS',
      lockedBy,
      leaseExpiresAt,
    );
    await processor.process(claimed(notificationPruneJob, lockedBy));
    expect(
      await prisma.notification.findMany({
        where: { id: { in: [oldRead.id, recentRead.id, oldArchived.id, unread.id] } },
        select: { id: true },
      }),
    ).toEqual(expect.arrayContaining([{ id: recentRead.id }, { id: unread.id }]));
    expect(
      await prisma.notification.count({ where: { id: { in: [oldRead.id, oldArchived.id] } } }),
    ).toBe(0);

    const oldCompletedAt = new Date(Date.now() - 31 * dayMs);
    const oldSucceeded = await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        jobType: 'PRUNE_NOTIFICATIONS',
        idempotencyKey: `integration:${suffix}:old-succeeded`,
        status: 'SUCCEEDED',
        completedAt: oldCompletedAt,
      },
    });
    const oldCancelled = await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        jobType: 'PRUNE_NOTIFICATIONS',
        idempotencyKey: `integration:${suffix}:old-cancelled`,
        status: 'CANCELLED',
        completedAt: oldCompletedAt,
      },
    });
    const oldDead = await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        jobType: 'PRUNE_NOTIFICATIONS',
        idempotencyKey: `integration:${suffix}:old-dead`,
        status: 'DEAD',
        completedAt: oldCompletedAt,
      },
    });
    const recentSucceeded = await prisma.maintenanceJob.create({
      data: {
        tenantId: tenant.id,
        jobType: 'PRUNE_NOTIFICATIONS',
        idempotencyKey: `integration:${suffix}:recent-succeeded`,
        status: 'SUCCEEDED',
        completedAt: new Date(Date.now() - dayMs),
      },
    });
    const jobPruneJob = await runningJob(
      prisma,
      tenant.id,
      `integration:${suffix}:prune-jobs`,
      'PRUNE_COMPLETED_JOBS',
      lockedBy,
      leaseExpiresAt,
    );
    await processor.process(claimed(jobPruneJob, lockedBy));
    expect(
      await prisma.maintenanceJob.count({
        where: { id: { in: [oldSucceeded.id, oldCancelled.id] } },
      }),
    ).toBe(0);
    expect(await prisma.maintenanceJob.findUnique({ where: { id: oldDead.id } })).not.toBeNull();
    expect(
      await prisma.maintenanceJob.findUnique({ where: { id: recentSucceeded.id } }),
    ).not.toBeNull();
    expect(
      await prisma.auditEvent.count({
        where: {
          tenantId: tenant.id,
          action: { in: ['maintenance.notifications.pruned', 'maintenance.jobs.pruned'] },
        },
      }),
    ).toBe(2);
  }, 30_000);

  it('keeps a shared storage object until its remaining asset reference is removed', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const payload = Buffer.from('shared lifecycle object', 'utf8');
    const objectKey = `integration/lifecycle/shared-${suffix}.txt`;
    objectKeys.add(objectKey);
    await minio.putObject(bucket, objectKey, payload, payload.length, {
      'Content-Type': 'text/plain',
    });

    const context = await createLifecycleContext(
      prisma,
      `shared-${suffix}`,
      BigInt(payload.length * 3),
    );
    const deletedNode = await createAssetNode(prisma, context, 'Deleted copy.txt');
    const retainedNode = await createAssetNode(prisma, context, 'Retained copy.txt');
    const stored = await prisma.storageObject.create({
      data: {
        bucket,
        objectKey,
        checksumSha256: '1'.repeat(64),
        sizeBytes: payload.length,
        referenceCount: 3,
      },
    });
    await createVersion(prisma, deletedNode.id, stored.id, context.userId, payload.length);
    const retained = await createVersion(
      prisma,
      retainedNode.id,
      stored.id,
      context.userId,
      payload.length,
    );
    const retainedSecondVersion = await prisma.assetVersion.create({
      data: {
        assetId: retained.asset.id,
        versionNumber: 2,
        storageObjectId: stored.id,
        status: 'AVAILABLE',
        scanStatus: 'SKIPPED',
        checksumSha256: '1'.repeat(64),
        sizeBytes: payload.length,
        mimeType: 'text/plain',
        createdById: context.userId,
      },
    });
    await prisma.asset.update({
      where: { id: retained.asset.id },
      data: { currentVersionId: retainedSecondVersion.id },
    });

    const batch = await prisma.deletionBatch.create({
      data: {
        tenantId: context.tenantId,
        spaceId: context.spaceId,
        rootNodeId: deletedNode.id,
        rootName: deletedNode.name,
        rootType: 'ASSET',
        deletedById: context.userId,
        deletedAt: new Date(Date.now() - 31 * 86_400_000),
        purgeAt: new Date(Date.now() - 86_400_000),
        itemCount: 1,
        sourceBytes: payload.length,
      },
    });
    await prisma.resourceNode.update({
      where: { id: deletedNode.id },
      data: { status: 'DELETED', deletedAt: batch.deletedAt, deletionBatchId: batch.id },
    });
    const lockedBy = `shared-${suffix}`;
    const purgeJob = await createRunningJob(prisma, {
      tenantId: context.tenantId,
      spaceId: context.spaceId,
      idempotencyKey: `integration:${suffix}:shared-purge`,
      jobType: 'PURGE_DELETION_BATCH',
      targetId: batch.id,
      lockedBy,
    });

    await processor.process(claimed(purgeJob, lockedBy));

    expect(await prisma.resourceNode.findUnique({ where: { id: deletedNode.id } })).toBeNull();
    expect(await prisma.resourceNode.findUnique({ where: { id: retainedNode.id } })).not.toBeNull();
    expect(
      await prisma.storageObject.findUniqueOrThrow({ where: { id: stored.id } }),
    ).toMatchObject({ referenceCount: 2 });
    expect(await prisma.space.findUniqueOrThrow({ where: { id: context.spaceId } })).toMatchObject({
      usedBytes: BigInt(payload.length * 2),
    });
    expect(
      await prisma.maintenanceJob.count({
        where: { idempotencyKey: `storage:${stored.id}:delete` },
      }),
    ).toBe(0);
    expect(await minio.statObject(bucket, objectKey)).toMatchObject({ size: payload.length });
  }, 30_000);

  it('retries upload aborts without duplicate expiry effects and protects completed sessions', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const context = await createLifecycleContext(prisma, `abort-${suffix}`, 0n);
    const expiredUpload = await prisma.uploadSession.create({
      data: {
        spaceId: context.spaceId,
        initiatedById: context.userId,
        uploadId: `abort-${suffix}`,
        objectKey: `integration/expired/retry-${suffix}.bin`,
        fileName: 'retry.bin',
        sizeBytes: 16n,
        mimeType: 'application/octet-stream',
        status: 'UPLOADING',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const completedUpload = await prisma.uploadSession.create({
      data: {
        spaceId: context.spaceId,
        initiatedById: context.userId,
        uploadId: `completed-${suffix}`,
        objectKey: `integration/expired/completed-${suffix}.bin`,
        fileName: 'completed.bin',
        sizeBytes: 16n,
        mimeType: 'application/octet-stream',
        status: 'COMPLETED',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const lockedBy = `abort-${suffix}`;
    const expiredJob = await createRunningJob(prisma, {
      tenantId: context.tenantId,
      spaceId: context.spaceId,
      idempotencyKey: `integration:${suffix}:abort-retry`,
      jobType: 'EXPIRE_UPLOAD_SESSION',
      targetId: expiredUpload.id,
      lockedBy,
    });
    const completedJob = await createRunningJob(prisma, {
      tenantId: context.tenantId,
      spaceId: context.spaceId,
      idempotencyKey: `integration:${suffix}:completed-protection`,
      jobType: 'EXPIRE_UPLOAD_SESSION',
      targetId: completedUpload.id,
      lockedBy,
    });
    const abortFailure = new Error('temporary MinIO abort failure');
    const abort = vi
      .spyOn(storage, 'abortMultipart')
      .mockRejectedValueOnce(abortFailure)
      .mockResolvedValue(undefined);

    await expect(processor.process(claimed(expiredJob, lockedBy))).rejects.toThrow(
      abortFailure.message,
    );
    await expect(processor.process(claimed(expiredJob, lockedBy))).resolves.toBeUndefined();
    await expect(processor.process(claimed(completedJob, lockedBy))).resolves.toBeUndefined();

    expect(abort).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenNthCalledWith(1, expiredUpload.objectKey, expiredUpload.uploadId);
    expect(abort).toHaveBeenNthCalledWith(2, expiredUpload.objectKey, expiredUpload.uploadId);
    abort.mockRestore();
    expect(
      await prisma.uploadSession.findUniqueOrThrow({ where: { id: expiredUpload.id } }),
    ).toMatchObject({ status: 'EXPIRED' });
    expect(
      await prisma.uploadSession.findUniqueOrThrow({ where: { id: completedUpload.id } }),
    ).toMatchObject({ status: 'COMPLETED' });
    expect(
      await prisma.auditEvent.count({
        where: {
          tenantId: context.tenantId,
          action: 'upload.expired',
          resourceId: expiredUpload.id,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.auditEvent.count({
        where: {
          tenantId: context.tenantId,
          action: 'upload.expired',
          resourceId: completedUpload.id,
        },
      }),
    ).toBe(0);
  }, 30_000);

  it('treats deletion of an already missing MinIO object as idempotent', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const context = await createLifecycleContext(prisma, `missing-${suffix}`, 0n);
    const objectKey = `integration/lifecycle/already-missing-${suffix}.bin`;
    const lockedBy = `missing-${suffix}`;
    const deletionJob = await createRunningJob(prisma, {
      tenantId: context.tenantId,
      spaceId: context.spaceId,
      idempotencyKey: `integration:${suffix}:missing-delete`,
      jobType: 'DELETE_STORAGE_OBJECT',
      targetId: randomUUID(),
      payload: { bucket, objectKey },
      lockedBy,
    });

    await expect(processor.process(claimed(deletionJob, lockedBy))).resolves.toBeUndefined();
    await expect(processor.process(claimed(deletionJob, lockedBy))).resolves.toBeUndefined();
    await expect(minio.statObject(bucket, objectKey)).rejects.toBeTruthy();
  }, 30_000);

  it('retries failed object deletion, records DEAD once, and runs a recovered job', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const payload = Buffer.from('delete retry payload', 'utf8');
    const objectKey = `integration/lifecycle/delete-retry-${suffix}.bin`;
    objectKeys.add(objectKey);
    await minio.putObject(bucket, objectKey, payload, payload.length);
    const context = await createLifecycleContext(prisma, `delete-retry-${suffix}`, 0n);
    const queue = new MaintenanceQueueService(
      prisma,
      new ConfigService({
        MAINTENANCE_WORKER_ID: `integration-${suffix}`,
        MAINTENANCE_LEASE_SECONDS: 60,
        MAINTENANCE_RETRY_BASE_SECONDS: 1,
      }),
    );
    const availableAt = new Date('1900-01-01T00:00:00.000Z');
    const created = await prisma.maintenanceJob.create({
      data: {
        tenantId: context.tenantId,
        spaceId: context.spaceId,
        jobType: 'DELETE_STORAGE_OBJECT',
        idempotencyKey: `integration:${suffix}:delete-retry`,
        targetId: randomUUID(),
        payload: { bucket, objectKey },
        maxAttempts: 2,
        availableAt,
      },
    });
    const failure = new Error('temporary MinIO deletion failure');
    const deletion = vi
      .spyOn(storage, 'removeObject')
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);

    const firstAttempt = await queue.claim();
    expect(firstAttempt?.id).toBe(created.id);
    await expect(processor.process(firstAttempt!)).rejects.toThrow(failure.message);
    await expect(
      queue.fail(firstAttempt!, failure, (database, terminal) =>
        processor.recordFailure(database, firstAttempt!, terminal, failure),
      ),
    ).resolves.toBe('RETRY');
    expect(
      await prisma.auditEvent.count({
        where: { action: 'storage.delete.failed', resourceId: created.targetId },
      }),
    ).toBe(0);

    await prisma.maintenanceJob.update({ where: { id: created.id }, data: { availableAt } });
    const terminalAttempt = await queue.claim();
    expect(terminalAttempt?.id).toBe(created.id);
    await expect(processor.process(terminalAttempt!)).rejects.toThrow(failure.message);
    await expect(
      queue.fail(terminalAttempt!, failure, (database, terminal) =>
        processor.recordFailure(database, terminalAttempt!, terminal, failure),
      ),
    ).resolves.toBe('DEAD');
    expect(
      await prisma.maintenanceJob.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ status: 'DEAD', attempts: 2 });
    expect(
      await prisma.auditEvent.count({
        where: { action: 'storage.delete.failed', resourceId: created.targetId },
      }),
    ).toBe(1);

    await prisma.maintenanceJob.update({
      where: { id: created.id },
      data: {
        status: 'PENDING',
        attempts: 0,
        availableAt,
        completedAt: null,
        errorMessage: null,
      },
    });
    deletion.mockRestore();
    const recoveredAttempt = await queue.claim();
    expect(recoveredAttempt?.id).toBe(created.id);
    await processor.process(recoveredAttempt!);
    await queue.complete(recoveredAttempt!.id);

    expect(
      await prisma.maintenanceJob.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ status: 'SUCCEEDED', attempts: 1, errorMessage: null });
    await expect(minio.statObject(bucket, objectKey)).rejects.toBeTruthy();
    objectKeys.delete(objectKey);
  }, 30_000);
});

async function createLifecycleContext(prisma: PrismaService, suffix: string, usedBytes: bigint) {
  const tenant = await prisma.tenant.create({
    data: { code: `lifecycle-${suffix}`, name: 'Lifecycle Integration' },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      loginName: `lifecycle-${suffix}`,
      email: `lifecycle-${suffix}@example.test`,
      displayName: 'Lifecycle User',
      status: 'ACTIVE',
    },
  });
  const space = await prisma.space.create({
    data: {
      tenantId: tenant.id,
      ownerType: 'TENANT',
      code: `lifecycle-${suffix}`,
      name: 'Lifecycle Space',
      createdById: user.id,
      quotaBytes: 1024n,
      usedBytes,
    },
  });
  const root = await prisma.resourceNode.create({
    data: {
      spaceId: space.id,
      nodeType: 'FOLDER',
      name: 'Root',
      normalizedName: 'root',
      isRoot: true,
      createdById: user.id,
    },
  });
  await prisma.resourceClosure.create({
    data: { ancestorId: root.id, descendantId: root.id, depth: 0 },
  });
  return { tenantId: tenant.id, userId: user.id, spaceId: space.id, rootId: root.id };
}

async function createAssetNode(
  prisma: PrismaService,
  context: Awaited<ReturnType<typeof createLifecycleContext>>,
  name: string,
) {
  const node = await prisma.resourceNode.create({
    data: {
      spaceId: context.spaceId,
      parentId: context.rootId,
      nodeType: 'ASSET',
      name,
      normalizedName: name.toLowerCase(),
      createdById: context.userId,
    },
  });
  await prisma.resourceClosure.createMany({
    data: [
      { ancestorId: node.id, descendantId: node.id, depth: 0 },
      { ancestorId: context.rootId, descendantId: node.id, depth: 1 },
    ],
  });
  return node;
}

async function createVersion(
  prisma: PrismaService,
  nodeId: string,
  storageObjectId: string,
  userId: string,
  sizeBytes: number,
) {
  const asset = await prisma.asset.create({
    data: { nodeId, originalFileName: 'Shared.txt', mimeType: 'text/plain' },
  });
  const version = await prisma.assetVersion.create({
    data: {
      assetId: asset.id,
      versionNumber: 1,
      storageObjectId,
      status: 'AVAILABLE',
      scanStatus: 'SKIPPED',
      checksumSha256: '1'.repeat(64),
      sizeBytes,
      mimeType: 'text/plain',
      createdById: userId,
    },
  });
  await prisma.asset.update({ where: { id: asset.id }, data: { currentVersionId: version.id } });
  return { asset, version };
}

function createRunningJob(
  prisma: PrismaService,
  input: {
    tenantId: string;
    spaceId: string;
    idempotencyKey: string;
    jobType: ClaimedMaintenanceJob['jobType'];
    targetId: string;
    payload?: Record<string, string>;
    lockedBy: string;
  },
) {
  return prisma.maintenanceJob.create({
    data: {
      tenantId: input.tenantId,
      spaceId: input.spaceId,
      idempotencyKey: input.idempotencyKey,
      jobType: input.jobType,
      targetId: input.targetId,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      status: 'RUNNING',
      attempts: 1,
      lockedAt: new Date(),
      lockedBy: input.lockedBy,
      leaseExpiresAt: new Date(Date.now() + 120_000),
    },
  });
}

function runningJob(
  prisma: PrismaService,
  tenantId: string,
  idempotencyKey: string,
  jobType: 'PRUNE_NOTIFICATIONS' | 'PRUNE_COMPLETED_JOBS',
  lockedBy: string,
  leaseExpiresAt: Date,
) {
  return prisma.maintenanceJob.create({
    data: {
      tenantId,
      jobType,
      idempotencyKey,
      status: 'RUNNING',
      attempts: 1,
      lockedAt: new Date(),
      lockedBy,
      leaseExpiresAt,
    },
  });
}

function claimed(
  job: {
    id: string;
    tenantId: string | null;
    spaceId: string | null;
    jobType: ClaimedMaintenanceJob['jobType'];
    targetId: string | null;
    payload: ClaimedMaintenanceJob['payload'];
    attempts: number;
    maxAttempts: number;
  },
  lockedBy: string,
): ClaimedMaintenanceJob {
  return { ...job, lockedBy };
}
