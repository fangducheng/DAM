import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { afterAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { assertLocalIntegrationRunner } from '../testing/integration-test.guard.js';
import { StorageReconciliationService } from './storage-reconciliation.service.js';

const integrationEnabled = process.env['DAM_MAINTENANCE_INTEGRATION_TESTS'] === '1';
assertLocalIntegrationRunner(integrationEnabled);
const integration = integrationEnabled ? describe : describe.skip;

if (integrationEnabled) {
  const rootEnvPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(rootEnvPath)) {
    process.loadEnvFile(rootEnvPath);
  }
}

interface TenantFixture {
  tenantId: string;
  userId: string;
  spaceId: string;
}

integration('storage reconciliation', () => {
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
  const storage = new ObjectStorageService(
    new ConfigService({
      MINIO_ENDPOINT: endpoint.toString(),
      MINIO_ACCESS_KEY: accessKey,
      MINIO_SECRET_KEY: secretKey,
      MINIO_BUCKET: bucket,
    }),
  );
  const reconciliation = new StorageReconciliationService(prisma, storage);
  const objectKeys = new Set<string>();

  afterAll(async () => {
    await Promise.all(
      [...objectKeys].map(async (objectKey) => {
        try {
          await minio.removeObject(bucket, objectKey);
        } catch {
          // A failed assertion must not prevent cleanup of the remaining fixtures.
        }
      }),
    );
    // The dedicated integration database retains append-only audit rows and their random Tenant.
    await prisma.$disconnect();
  });

  it('isolates Tenant issues, redacts storage details, preserves unknown objects, and paginates', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const tenantA = await createTenantFixture(prisma, `reconcile-a-${suffix}`);
    const tenantB = await createTenantFixture(prisma, `reconcile-b-${suffix}`);

    const knownPayload = Buffer.from('known tenant A reconciliation object', 'utf8');
    const registeredPayload = Buffer.from('registered tenant A reconciliation object', 'utf8');
    const pendingCommitPayload = Buffer.from(
      'completed multipart pending commit tenant A object',
      'utf8',
    );
    const staleCompletedUploadPayload = Buffer.from(
      'stale completed upload tenant A reconciliation object',
      'utf8',
    );
    const pendingDeletionPayload = Buffer.from(
      'pending deletion tenant A reconciliation object',
      'utf8',
    );
    const unknownPayload = Buffer.from('unknown tenant A reconciliation object', 'utf8');
    const tenantBUnknownPayload = Buffer.from('unknown tenant B reconciliation object', 'utf8');
    const knownKey = `tenants/${tenantA.tenantId}/integration/reconciliation/known-secret-${suffix}.bin`;
    const missingKey = `tenants/${tenantA.tenantId}/integration/reconciliation/missing-secret-${suffix}.bin`;
    const registeredKey = `tenants/${tenantA.tenantId}/integration/reconciliation/registered-secret-${suffix}.bin`;
    const pendingCommitKey = `tenants/${tenantA.tenantId}/integration/reconciliation/pending-commit-secret-${suffix}.bin`;
    const staleCompletedUploadKey = `tenants/${tenantA.tenantId}/integration/reconciliation/stale-completed-secret-${suffix}.bin`;
    const pendingDeletionKey = `tenants/${tenantA.tenantId}/integration/reconciliation/pending-deletion-secret-${suffix}.bin`;
    const unknownKey = `tenants/${tenantA.tenantId}/integration/reconciliation/unknown-secret-${suffix}.bin`;
    const tenantBMissingKey = `tenants/${tenantB.tenantId}/integration/reconciliation/missing-secret-${suffix}.bin`;
    const tenantBUnknownKey = `tenants/${tenantB.tenantId}/integration/reconciliation/unknown-secret-${suffix}.bin`;
    objectKeys.add(knownKey);
    objectKeys.add(missingKey);
    objectKeys.add(registeredKey);
    objectKeys.add(pendingCommitKey);
    objectKeys.add(staleCompletedUploadKey);
    objectKeys.add(pendingDeletionKey);
    objectKeys.add(unknownKey);
    objectKeys.add(tenantBMissingKey);
    objectKeys.add(tenantBUnknownKey);

    await Promise.all([
      minio.putObject(bucket, knownKey, knownPayload, knownPayload.length),
      minio.putObject(bucket, registeredKey, registeredPayload, registeredPayload.length),
      minio.putObject(bucket, pendingCommitKey, pendingCommitPayload, pendingCommitPayload.length),
      minio.putObject(
        bucket,
        staleCompletedUploadKey,
        staleCompletedUploadPayload,
        staleCompletedUploadPayload.length,
      ),
      minio.putObject(
        bucket,
        pendingDeletionKey,
        pendingDeletionPayload,
        pendingDeletionPayload.length,
      ),
      minio.putObject(bucket, unknownKey, unknownPayload, unknownPayload.length),
      minio.putObject(
        bucket,
        tenantBUnknownKey,
        tenantBUnknownPayload,
        tenantBUnknownPayload.length,
      ),
    ]);

    await createDatabaseObject(prisma, tenantA, bucket, knownKey, knownPayload, 'Known asset.bin');
    const missingObject = await createDatabaseObject(
      prisma,
      tenantA,
      bucket,
      missingKey,
      Buffer.from('missing tenant A reconciliation object', 'utf8'),
      'Missing asset.bin',
    );
    const tenantBMissingObject = await createDatabaseObject(
      prisma,
      tenantB,
      bucket,
      tenantBMissingKey,
      Buffer.from('missing tenant B reconciliation object', 'utf8'),
      'Other tenant asset.bin',
    );
    await prisma.storageObject.create({
      data: {
        bucket,
        objectKey: registeredKey,
        checksumSha256: createHash('sha256').update(registeredPayload).digest('hex'),
        sizeBytes: BigInt(registeredPayload.length),
      },
    });
    await prisma.uploadSession.createMany({
      data: [
        {
          spaceId: tenantA.spaceId,
          initiatedById: tenantA.userId,
          uploadId: `reconcile-pending-commit-${suffix}`,
          objectKey: pendingCommitKey,
          fileName: 'Pending commit asset.bin',
          sizeBytes: BigInt(pendingCommitPayload.length),
          mimeType: 'application/octet-stream',
          status: 'UPLOADING',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          spaceId: tenantA.spaceId,
          initiatedById: tenantA.userId,
          uploadId: `reconcile-stale-completed-${suffix}`,
          objectKey: staleCompletedUploadKey,
          fileName: 'Stale completed upload asset.bin',
          sizeBytes: BigInt(staleCompletedUploadPayload.length),
          mimeType: 'application/octet-stream',
          status: 'COMPLETED',
          expiresAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      ],
    });
    await prisma.maintenanceJob.create({
      data: {
        tenantId: tenantA.tenantId,
        spaceId: tenantA.spaceId,
        jobType: 'DELETE_STORAGE_OBJECT',
        idempotencyKey: `reconciliation:${suffix}:pending-delete`,
        targetId: randomUUID(),
        payload: { bucket, objectKey: pendingDeletionKey },
      },
    });

    const actor: AuthenticatedUser = {
      userId: tenantA.userId,
      tenantId: tenantA.tenantId,
      sessionId: randomUUID(),
      authenticationMethods: ['password', 'totp'],
    };
    const requestId = `reconciliation-${suffix}`;
    const metadata = {
      ipAddress: '127.0.0.1',
      userAgent: 'storage-reconciliation-integration',
      requestId,
    };

    const complete = await reconciliation.report(actor, { limit: 50 }, metadata);

    expect(complete.summary).toEqual({
      databaseObjects: 3,
      storageObjects: 6,
      missingObjects: 1,
      unknownObjects: 2,
    });
    expect(complete.items).toHaveLength(3);
    expect(complete.nextCursor).toBeNull();
    expect(
      complete.items.find((item) => item.issueType === 'DATABASE_OBJECT_MISSING'),
    ).toMatchObject({
      issueType: 'DATABASE_OBJECT_MISSING',
      storageObjectId: missingObject.id,
      expectedSizeBytes: String(Buffer.byteLength('missing tenant A reconciliation object')),
    });
    const unknownItem = complete.items.find(
      (item) =>
        item.issueType === 'STORAGE_OBJECT_UNKNOWN' &&
        item.id === issueId('STORAGE_OBJECT_UNKNOWN', unknownKey),
    );
    expect(unknownItem).toMatchObject({
      issueType: 'STORAGE_OBJECT_UNKNOWN',
      observedSizeBytes: String(unknownPayload.length),
    });
    expect(
      unknownItem?.issueType === 'STORAGE_OBJECT_UNKNOWN' && unknownItem.objectFingerprint,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      complete.items.find(
        (item) =>
          item.issueType === 'STORAGE_OBJECT_UNKNOWN' &&
          item.id === issueId('STORAGE_OBJECT_UNKNOWN', staleCompletedUploadKey),
      ),
    ).toMatchObject({
      issueType: 'STORAGE_OBJECT_UNKNOWN',
      observedSizeBytes: String(staleCompletedUploadPayload.length),
    });
    expect(complete.items).not.toContainEqual(
      expect.objectContaining({ storageObjectId: tenantBMissingObject.id }),
    );
    expect(complete.items.map(({ id }) => id)).not.toContain(
      issueId('STORAGE_OBJECT_UNKNOWN', tenantBUnknownKey),
    );
    for (const legitimateKey of [registeredKey, pendingCommitKey, pendingDeletionKey]) {
      expect(complete.items.map(({ id }) => id)).not.toContain(
        issueId('STORAGE_OBJECT_UNKNOWN', legitimateKey),
      );
    }

    const firstPage = await reconciliation.report(actor, { limit: 2 }, metadata);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBe(firstPage.items[1]!.id);
    const secondPage = await reconciliation.report(
      actor,
      { cursor: firstPage.nextCursor!, limit: 2 },
      metadata,
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map(({ id }) => id)).toEqual(
      complete.items.map(({ id }) => id),
    );

    await expect(storage.objectExists(bucket, unknownKey)).resolves.toBe(true);
    await expect(storage.objectExists(bucket, staleCompletedUploadKey)).resolves.toBe(true);
    await expect(storage.objectExists(bucket, tenantBUnknownKey)).resolves.toBe(true);

    const audits = await prisma.auditEvent.findMany({
      where: {
        tenantId: tenantA.tenantId,
        action: 'storage.reconciliation.read',
        requestId,
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audits).toHaveLength(3);
    expect(audits.every((audit) => audit.result === 'SUCCEEDED')).toBe(true);
    expect(audits.at(-1)?.details).toEqual({
      databaseObjects: 3,
      storageObjects: 6,
      missingObjects: 1,
      unknownObjects: 2,
      returnedItems: 1,
      hasNextPage: false,
    });

    const serializedOutput = JSON.stringify({ complete, firstPage, secondPage, audits });
    for (const secret of [
      knownKey,
      missingKey,
      registeredKey,
      pendingCommitKey,
      staleCompletedUploadKey,
      pendingDeletionKey,
      unknownKey,
      tenantBMissingKey,
      tenantBUnknownKey,
      bucket,
      accessKey,
      secretKey,
    ]) {
      expect(serializedOutput).not.toContain(secret);
    }
  }, 30_000);
});

async function createTenantFixture(prisma: PrismaService, code: string): Promise<TenantFixture> {
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
  const space = await prisma.space.create({
    data: {
      tenantId: tenant.id,
      ownerType: 'TENANT',
      code,
      name: `${code} Space`,
      createdById: user.id,
      quotaBytes: 1024n * 1024n,
    },
  });
  return { tenantId: tenant.id, userId: user.id, spaceId: space.id };
}

async function createDatabaseObject(
  prisma: PrismaService,
  fixture: TenantFixture,
  bucket: string,
  objectKey: string,
  payload: Buffer,
  fileName: string,
) {
  const node = await prisma.resourceNode.create({
    data: {
      spaceId: fixture.spaceId,
      nodeType: 'ASSET',
      name: fileName,
      normalizedName: fileName.toLocaleLowerCase('en-US'),
      createdById: fixture.userId,
    },
  });
  const asset = await prisma.asset.create({
    data: {
      nodeId: node.id,
      originalFileName: fileName,
      mimeType: 'application/octet-stream',
    },
  });
  const checksumSha256 = createHash('sha256').update(payload).digest('hex');
  const storageObject = await prisma.storageObject.create({
    data: {
      bucket,
      objectKey,
      checksumSha256,
      sizeBytes: BigInt(payload.length),
    },
  });
  const version = await prisma.assetVersion.create({
    data: {
      assetId: asset.id,
      versionNumber: 1,
      storageObjectId: storageObject.id,
      status: 'AVAILABLE',
      scanStatus: 'SKIPPED',
      checksumSha256,
      sizeBytes: BigInt(payload.length),
      mimeType: 'application/octet-stream',
      createdById: fixture.userId,
    },
  });
  await prisma.asset.update({
    where: { id: asset.id },
    data: { currentVersionId: version.id },
  });
  return storageObject;
}

function issueId(issueType: 'STORAGE_OBJECT_UNKNOWN', objectKey: string): string {
  return createHash('sha256').update(issueType).update('\0').update(objectKey).digest('hex');
}
