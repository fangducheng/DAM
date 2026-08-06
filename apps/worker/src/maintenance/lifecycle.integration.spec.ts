import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { afterAll, describe, expect, it } from 'vitest';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { ClaimedMaintenanceJob } from './maintenance-job.types.js';
import { MaintenanceProcessorService } from './maintenance-processor.service.js';

const integrationEnabled = process.env['DAM_LIFECYCLE_INTEGRATION_TESTS'] === '1';
const integration = integrationEnabled ? describe : describe.skip;

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
});

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
