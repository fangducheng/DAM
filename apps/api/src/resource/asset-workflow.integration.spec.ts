import { createHash, randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationPolicy } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { RedisService } from '../infrastructure/redis.service.js';
import { SpaceService } from '../space/space.service.js';
import { AssetService } from './asset.service.js';
import { ResourceService } from './resource.service.js';
import { UploadService } from './upload.service.js';

const integrationEnabled = process.env['DAM_ASSET_INTEGRATION_TESTS'] === '1';
const integration = integrationEnabled ? describe : describe.skip;

integration('resource hierarchy and resumable asset workflow', () => {
  const prisma = new PrismaService();
  const cache = new Map<string, unknown>();
  const redis = {
    getJson<T>(key: string): Promise<T | null> {
      return Promise.resolve((cache.get(key) as T | undefined) ?? null);
    },
    setJson(key: string, value: unknown): Promise<void> {
      cache.set(key, value);
      return Promise.resolve();
    },
  } as unknown as RedisService;
  const config = new ConfigService({
    AUTHORIZATION_CACHE_TTL_SECONDS: 300,
    MINIO_ENDPOINT: process.env['MINIO_ENDPOINT'] ?? 'http://localhost:9000',
    MINIO_ACCESS_KEY: process.env['MINIO_ACCESS_KEY'] ?? 'dam_local_admin',
    MINIO_SECRET_KEY: process.env['MINIO_SECRET_KEY'] ?? 'dam_local_password',
    MINIO_BUCKET: process.env['MINIO_BUCKET'] ?? 'dam-assets',
    ASSET_UPLOAD_SESSION_TTL_HOURS: 24,
    ASSET_UPLOAD_URL_TTL_SECONDS: 900,
    ASSET_READ_URL_TTL_SECONDS: 60,
    ASSET_PROCESSING_MODE: 'local-bypass',
  });
  const authorization = new AuthorizationService(prisma, redis, new AuthorizationPolicy(), config);
  const storage = new ObjectStorageService(config);
  const spaces = new SpaceService(prisma, authorization);
  const resources = new ResourceService(prisma, authorization);
  const uploads = new UploadService(prisma, authorization, storage, config);
  const assets = new AssetService(prisma, authorization, storage, config);
  let tenantId: string | undefined;

  afterAll(async () => {
    if (tenantId !== undefined) {
      const objects = await prisma.storageObject.findMany({
        where: {
          sourceVersions: { some: { asset: { node: { space: { tenantId } } } } },
        },
        select: { objectKey: true },
      });
      await Promise.all(objects.map(({ objectKey }) => storage.removeObject(objectKey)));
    }
    await prisma.$disconnect();
  });

  it('uploads multipart versions and preserves one deletion batch through restore', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const platformAdmin = await prisma.role.findUniqueOrThrow({
      where: { code: 'platform_admin' },
    });
    const tenant = await prisma.tenant.create({
      data: {
        code: `asset-${suffix}`,
        name: 'Asset Workflow Integration',
        securityPolicy: { create: {} },
      },
    });
    tenantId = tenant.id;
    const administrator = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `asset-admin-${suffix}`,
        email: `asset-admin-${suffix}@example.test`,
        displayName: 'Asset Administrator',
        status: 'ACTIVE',
      },
    });
    await prisma.roleBinding.create({
      data: {
        tenantId: tenant.id,
        roleId: platformAdmin.id,
        principalType: 'USER',
        principalId: administrator.id,
        scopeType: 'TENANT',
        scopeId: tenant.id,
      },
    });
    const actor: AuthenticatedUser = {
      userId: administrator.id,
      tenantId: tenant.id,
      sessionId: randomUUID(),
      authenticationMethods: ['password', 'totp'],
    };
    const metadata = { ipAddress: '127.0.0.1', requestId: randomUUID() };
    const space = await spaces.create(
      actor,
      {
        code: `asset-space-${suffix}`,
        name: 'Asset Space',
        ownerType: 'TENANT',
        quotaBytes: String(64 * 1024 * 1024),
      },
      metadata,
    );
    const folder = await resources.createFolder(actor, space.id, { name: 'Contracts' }, metadata);

    const firstPayload = Buffer.alloc(9 * 1024 * 1024, 0x41);
    const firstChecksum = createHash('sha256').update(firstPayload).digest('hex');
    const firstUpload = await uploads.create(
      actor,
      space.id,
      {
        targetFolderId: folder.id,
        fileName: 'Master Agreement.pdf',
        sizeBytes: String(firstPayload.length),
        mimeType: 'application/pdf',
        checksumSha256: firstChecksum,
      },
      metadata,
    );
    expect(firstUpload.partCount).toBe(2);
    await uploadParts(actor, firstUpload, firstPayload, uploads);
    const firstAsset = await uploads.complete(actor, firstUpload.id, metadata);
    expect(firstAsset).toMatchObject({
      versionNumber: 1,
      status: 'AVAILABLE',
      scanStatus: 'SKIPPED',
    });

    const folderPage = await resources.list(actor, space.id, { parentId: folder.id, limit: 50 });
    const assetNode = folderPage.items.find((item) => item.id === firstAsset.nodeId);
    expect(assetNode).toMatchObject({ name: 'Master Agreement.pdf', nodeType: 'ASSET' });

    const secondPayload = Buffer.from('second immutable version', 'utf8');
    const secondUpload = await uploads.create(
      actor,
      space.id,
      {
        assetId: firstAsset.assetId,
        fileName: 'Master Agreement v2.pdf',
        sizeBytes: String(secondPayload.length),
        mimeType: 'application/pdf',
      },
      metadata,
    );
    await uploadParts(actor, secondUpload, secondPayload, uploads);
    const secondAsset = await uploads.complete(actor, secondUpload.id, metadata);
    expect(secondAsset.versionNumber).toBe(2);

    const history = await assets.versions(actor, firstAsset.assetId);
    expect(history.items.map(({ versionNumber }) => versionNumber)).toEqual([2, 1]);
    await assets.setCurrentVersion(actor, firstAsset.assetId, firstAsset.versionId, metadata);
    const preview = await assets.nodeUrl(actor, firstAsset.nodeId, 'preview');
    const previewResponse = await fetch(preview.url);
    expect(previewResponse.ok).toBe(true);
    const previewPayload = Buffer.from(await previewResponse.arrayBuffer());
    expect(previewPayload.length).toBe(firstPayload.length);
    expect(createHash('sha256').update(previewPayload).digest('hex')).toBe(firstChecksum);

    const currentNode = await resources.get(actor, firstAsset.nodeId);
    await resources.trash(
      actor,
      firstAsset.nodeId,
      { lockVersion: currentNode.lockVersion },
      metadata,
    );
    const recycle = await resources.recycleBin(actor, space.id, { limit: 50 });
    const deleted = recycle.items.find((item) => item.id === firstAsset.nodeId);
    expect(deleted?.status).toBe('DELETED');
    expect(deleted?.deletionBatch).toMatchObject({
      status: 'RETAINED',
      itemCount: 1,
      sourceBytes: String(firstPayload.length + secondPayload.length),
    });
    expect(
      await prisma.maintenanceJob.count({
        where: { targetId: deleted!.deletionBatchId, status: 'PENDING' },
      }),
    ).toBe(3);
    const restored = await resources.restore(
      actor,
      firstAsset.nodeId,
      { lockVersion: deleted!.lockVersion },
      metadata,
    );
    expect(restored.status).toBe('ACTIVE');
    expect(
      await prisma.maintenanceJob.count({
        where: { targetId: deleted!.deletionBatchId, status: 'CANCELLED' },
      }),
    ).toBe(3);

    await resources.trash(
      actor,
      firstAsset.nodeId,
      { lockVersion: restored.lockVersion },
      metadata,
    );
    const secondRecycle = await resources.recycleBin(actor, space.id, { limit: 50 });
    const retained = secondRecycle.items.find((item) => item.id === firstAsset.nodeId)!;
    await expect(
      resources.requestPurge(
        actor,
        firstAsset.nodeId,
        { lockVersion: retained.lockVersion, confirmationName: 'wrong name' },
        metadata,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const requested = await resources.requestPurge(
      actor,
      firstAsset.nodeId,
      { lockVersion: retained.lockVersion, confirmationName: retained.name },
      metadata,
    );
    expect(requested.status).toBe('PURGE_REQUESTED');
    expect(
      await prisma.deletionBatch.findUniqueOrThrow({
        where: { id: retained.deletionBatchId! },
        select: { status: true },
      }),
    ).toEqual({ status: 'PURGE_REQUESTED' });
  }, 60_000);
});

async function uploadParts(
  actor: AuthenticatedUser,
  session: { id: string; partCount: number; partSize: number },
  payload: Buffer,
  uploads: UploadService,
): Promise<void> {
  for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
    const start = (partNumber - 1) * session.partSize;
    const chunk = payload.subarray(start, Math.min(payload.length, start + session.partSize));
    const signed = await uploads.partUrl(actor, session.id, partNumber);
    const response = await fetch(signed.url, { method: 'PUT', body: chunk });
    expect(response.ok).toBe(true);
    const etag = response.headers.get('etag');
    expect(etag).not.toBeNull();
    await uploads.recordPart(actor, session.id, partNumber, {
      etag: etag!,
      sizeBytes: String(chunk.length),
    });
  }
}
