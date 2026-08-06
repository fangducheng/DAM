import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';

import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { AssetProcessingService } from './asset-processing.service.js';
import { ClamAvService } from './clamav.service.js';
import { ContentExtractionService } from './content-extraction.service.js';
import { ProcessingQueueService } from './processing-queue.service.js';

const integrationEnabled = process.env['DAM_PROCESSING_INTEGRATION_TESTS'] === '1';
const integration = integrationEnabled ? describe : describe.skip;

integration('deferred processing pipeline', () => {
  const prisma = new PrismaService();
  let server: Server;
  let clamAvPort = 0;

  beforeAll(async () => {
    server = createServer((socket) => {
      let request = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        if (request.length >= 4 && request.subarray(-4).equals(Buffer.alloc(4))) {
          socket.end('stream: OK\0');
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Fake ClamAV did not bind');
    clamAvPort = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  it('publishes a clean version, extracts text, and records a preview capability', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const endpoint = new URL(process.env['MINIO_ENDPOINT'] ?? 'http://localhost:9000');
    const bucket = process.env['MINIO_BUCKET'] ?? 'dam-assets';
    const minio = new Client({
      endPoint: endpoint.hostname,
      port: Number(endpoint.port || 9000),
      useSSL: endpoint.protocol === 'https:',
      accessKey: process.env['MINIO_ACCESS_KEY'] ?? 'dam_local_admin',
      secretKey: process.env['MINIO_SECRET_KEY'] ?? 'dam_local_password',
    });
    const objectKey = `integration/processing/${suffix}.txt`;
    const payload = Buffer.from('shared agreement searchable content', 'utf8');
    await minio.putObject(bucket, objectKey, payload, payload.length, {
      'Content-Type': 'text/plain',
    });

    try {
      const tenant = await prisma.tenant.create({
        data: { code: `processing-${suffix}`, name: 'Processing Integration' },
      });
      const user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          loginName: `processing-${suffix}`,
          email: `processing-${suffix}@example.test`,
          displayName: 'Processing User',
          status: 'ACTIVE',
        },
      });
      const space = await prisma.space.create({
        data: {
          tenantId: tenant.id,
          ownerType: 'TENANT',
          code: `processing-${suffix}`,
          name: 'Processing Space',
          createdById: user.id,
        },
      });
      const node = await prisma.resourceNode.create({
        data: {
          spaceId: space.id,
          nodeType: 'ASSET',
          name: 'processing.txt',
          normalizedName: 'processing.txt',
          status: 'QUARANTINED',
          createdById: user.id,
        },
      });
      const asset = await prisma.asset.create({
        data: { nodeId: node.id, originalFileName: node.name, mimeType: 'text/plain' },
      });
      const object = await prisma.storageObject.create({
        data: {
          bucket,
          objectKey,
          checksumSha256: '1'.repeat(64),
          sizeBytes: BigInt(payload.length),
        },
      });
      const version = await prisma.assetVersion.create({
        data: {
          assetId: asset.id,
          versionNumber: 1,
          storageObjectId: object.id,
          status: 'QUARANTINED',
          scanStatus: 'PENDING',
          checksumSha256: object.checksumSha256,
          sizeBytes: object.sizeBytes,
          mimeType: 'text/plain',
          createdById: user.id,
          processingJobs: { create: { jobType: 'MALWARE_SCAN' } },
        },
      });
      await prisma.asset.update({
        where: { id: asset.id },
        data: { currentVersionId: version.id },
      });

      const config = new ConfigService({
        PROCESSING_WORKER_ID: `worker-${suffix}`,
        PROCESSING_LEASE_SECONDS: 60,
        PROCESSING_RETRY_BASE_SECONDS: 1,
        CLAMAV_ENABLED: true,
        CLAMAV_HOST: '127.0.0.1',
        CLAMAV_PORT: clamAvPort,
        CLAMAV_TIMEOUT_MS: 5_000,
        CLAMAV_MAX_STREAM_BYTES: 10_000_000,
        TIKA_ENABLED: false,
        TIKA_ENDPOINT: 'http://127.0.0.1:9998',
        TIKA_TIMEOUT_MS: 5_000,
        CONTENT_EXTRACTION_MAX_CHARS: 10_000,
        MINIO_ENDPOINT: endpoint.toString(),
        MINIO_ACCESS_KEY: process.env['MINIO_ACCESS_KEY'] ?? 'dam_local_admin',
        MINIO_SECRET_KEY: process.env['MINIO_SECRET_KEY'] ?? 'dam_local_password',
        MINIO_BUCKET: bucket,
      });
      const queue = new ProcessingQueueService(prisma, config);
      const processor = new AssetProcessingService(
        prisma,
        new ObjectStorageService(config),
        new ClamAvService(config),
        new ContentExtractionService(config),
      );

      const abandonedJob = await queue.claim();
      expect(abandonedJob).not.toBeNull();
      await prisma.processingJob.update({
        where: { id: abandonedJob!.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      const recoveryQueue = new ProcessingQueueService(prisma, config);
      const recoveredJob = await recoveryQueue.claim();
      expect(recoveredJob).not.toBeNull();
      expect(recoveredJob!.id).toBe(abandonedJob!.id);
      expect(recoveredJob!.lockedBy).not.toBe(abandonedJob!.lockedBy);
      await expect(processor.process(abandonedJob!)).rejects.toThrow(
        `Processing job ${abandonedJob!.id} lease was lost`,
      );
      expect(
        await prisma.assetVersion.findUniqueOrThrow({
          where: { id: version.id },
          select: { status: true },
        }),
      ).not.toMatchObject({ status: 'AVAILABLE' });
      await processor.process(recoveredJob!);
      await recoveryQueue.complete(recoveredJob!.id);

      for (let index = 0; index < 2; index += 1) {
        const job = await recoveryQueue.claim();
        expect(job).not.toBeNull();
        await processor.process(job!);
        await recoveryQueue.complete(job!.id);
      }

      const processed = await prisma.assetVersion.findUniqueOrThrow({
        where: { id: version.id },
        include: { extraction: true, renditions: true, processingJobs: true },
      });
      expect(processed).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN' });
      expect(processed.extraction?.content).toContain('searchable content');
      expect(processed.renditions).toEqual([
        expect.objectContaining({ type: 'BROWSER_PREVIEW', status: 'AVAILABLE' }),
      ]);
      expect(processed.processingJobs.every((job) => job.status === 'SUCCEEDED')).toBe(true);
      expect(
        await prisma.notification.count({
          where: { userId: user.id, type: 'asset.processing.available' },
        }),
      ).toBe(1);

      await prisma.processingJob.create({
        data: {
          assetVersionId: version.id,
          jobType: 'INTEGRATION_TERMINAL_FAILURE',
          maxAttempts: 1,
        },
      });
      const terminalJob = await queue.claim();
      expect(terminalJob).not.toBeNull();
      const processingError = new Error('integration processor failure');
      await expect(
        queue.fail(terminalJob!, processingError, (database, terminal) =>
          processor.recordFailure(database, terminalJob!, terminal, processingError),
        ),
      ).resolves.toBe('DEAD');
      expect(
        await prisma.notification.count({
          where: { userId: user.id, type: 'asset.processing.partial-failure' },
        }),
      ).toBe(1);
      await expect(
        queue.fail(terminalJob!, processingError, (database, terminal) =>
          processor.recordFailure(database, terminalJob!, terminal, processingError),
        ),
      ).rejects.toThrow(`Processing job ${terminalJob!.id} lease was lost`);
      await expect(queue.complete(terminalJob!.id)).rejects.toThrow(
        `Processing job ${terminalJob!.id} lease was lost`,
      );
      expect(
        await prisma.notification.count({
          where: { userId: user.id, type: 'asset.processing.partial-failure' },
        }),
      ).toBe(1);
    } finally {
      await minio.removeObject(bucket, objectKey);
    }
  }, 30_000);
});
