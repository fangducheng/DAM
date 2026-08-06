import { Injectable } from '@nestjs/common';

import { Prisma } from '@dam/database';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ClamAvService, type MalwareScanResult } from './clamav.service.js';
import { ContentExtractionService } from './content-extraction.service.js';
import type { ClaimedProcessingJob, ProcessingJobType } from './processing-job.types.js';

@Injectable()
export class AssetProcessingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly clamAv: ClamAvService,
    private readonly extractor: ContentExtractionService,
  ) {}

  async process(job: ClaimedProcessingJob): Promise<void> {
    switch (job.jobType as ProcessingJobType) {
      case 'MALWARE_SCAN':
        await this.scan(job);
        return;
      case 'CONTENT_EXTRACT':
        await this.extract(job.assetVersionId);
        return;
      case 'PREVIEW_RENDITION':
        await this.createBrowserRendition(job.assetVersionId);
        return;
      default:
        throw new Error(`Unsupported processing job type: ${job.jobType}`);
    }
  }

  async recordFailure(
    database: Prisma.TransactionClient,
    job: ClaimedProcessingJob,
    terminal: boolean,
    error: unknown,
  ): Promise<void> {
    if (job.jobType !== 'MALWARE_SCAN') {
      if (terminal) {
        await this.notifyPartialFailure(database, job, error);
      }
      return;
    }

    if (!terminal) {
      await database.assetVersion.updateMany({
        where: { id: job.assetVersionId, scanStatus: { in: ['PENDING', 'ERROR'] } },
        data: { status: 'QUARANTINED', scanStatus: 'ERROR' },
      });
      return;
    }

    const changed = await database.assetVersion.updateMany({
      where: {
        id: job.assetVersionId,
        status: { in: ['QUARANTINED', 'PROCESSING'] },
        scanStatus: { in: ['PENDING', 'ERROR'] },
      },
      data: { status: 'FAILED', scanStatus: 'ERROR' },
    });
    if (changed.count === 0) {
      return;
    }
    const version = await this.version(database, job.assetVersionId);
    await this.restoreFallback(database, version);
    await this.auditAndNotify(database, version, 'asset.processing.failed', {
      versionId: version.id,
      message: this.safeError(error),
    });
  }

  private async scan(job: ClaimedProcessingJob): Promise<void> {
    const version = await this.version(this.prisma, job.assetVersionId);
    if (['CLEAN', 'INFECTED'].includes(version.scanStatus)) {
      return;
    }
    await this.prisma.assetVersion.updateMany({
      where: { id: job.assetVersionId, scanStatus: { in: ['PENDING', 'ERROR'] } },
      data: { status: 'PROCESSING', scanStatus: 'PENDING' },
    });
    const result = await this.clamAv.scan(
      await this.storage.getObject(version.storageObject.objectKey),
    );
    if (result.status === 'CLEAN') {
      await this.acceptClean(job);
    } else {
      await this.rejectInfected(job, result);
    }
  }

  private async acceptClean(job: ClaimedProcessingJob): Promise<void> {
    await this.prisma.$transaction(async (database) => {
      await this.assertActiveLease(database, job);
      const changed = await database.assetVersion.updateMany({
        where: { id: job.assetVersionId, scanStatus: { in: ['PENDING', 'ERROR'] } },
        data: { status: 'AVAILABLE', scanStatus: 'CLEAN' },
      });
      if (changed.count === 0) {
        return;
      }
      const version = await this.version(database, job.assetVersionId);
      if (version.asset.currentVersionId === version.id) {
        await database.resourceNode.update({
          where: { id: version.asset.node.id },
          data: { status: 'ACTIVE', lockVersion: { increment: 1 } },
        });
      }
      await database.processingJob.createMany({
        data: [
          { assetVersionId: version.id, jobType: 'CONTENT_EXTRACT' },
          { assetVersionId: version.id, jobType: 'PREVIEW_RENDITION' },
        ],
        skipDuplicates: true,
      });
      await this.auditAndNotify(database, version, 'asset.processing.available', {
        assetId: version.asset.id,
        nodeId: version.asset.node.id,
        versionId: version.id,
        versionNumber: version.versionNumber,
      });
    });
  }

  private async rejectInfected(
    job: ClaimedProcessingJob,
    result: Extract<MalwareScanResult, { status: 'INFECTED' }>,
  ): Promise<void> {
    await this.prisma.$transaction(async (database) => {
      await this.assertActiveLease(database, job);
      const changed = await database.assetVersion.updateMany({
        where: { id: job.assetVersionId, scanStatus: { in: ['PENDING', 'ERROR'] } },
        data: { status: 'REJECTED', scanStatus: 'INFECTED' },
      });
      if (changed.count === 0) {
        return;
      }
      const version = await this.version(database, job.assetVersionId);
      await this.restoreFallback(database, version);
      await this.auditAndNotify(database, version, 'asset.processing.infected', {
        assetId: version.asset.id,
        nodeId: version.asset.node.id,
        versionId: version.id,
        versionNumber: version.versionNumber,
        signature: result.signature,
      });
    });
  }

  private async extract(assetVersionId: string): Promise<void> {
    const version = await this.version(this.prisma, assetVersionId);
    if (version.status !== 'AVAILABLE' || version.scanStatus !== 'CLEAN') {
      return;
    }
    const extracted = await this.extractor.extract(
      version.mimeType,
      await this.storage.getObject(version.storageObject.objectKey),
    );
    if (extracted === null) {
      return;
    }
    await this.prisma.contentExtraction.upsert({
      where: { assetVersionId },
      create: {
        assetVersionId,
        content: extracted.content,
        parserVersion: extracted.parserVersion,
      },
      update: {
        content: extracted.content,
        parserVersion: extracted.parserVersion,
        extractedAt: new Date(),
      },
    });
  }

  private async createBrowserRendition(assetVersionId: string): Promise<void> {
    const version = await this.version(this.prisma, assetVersionId);
    if (
      version.status !== 'AVAILABLE' ||
      version.scanStatus !== 'CLEAN' ||
      !this.browserReadable(version.mimeType)
    ) {
      return;
    }
    await this.prisma.$transaction(async (database) => {
      const existing = await database.assetRendition.findUnique({
        where: {
          assetVersionId_type_variant: {
            assetVersionId,
            type: 'BROWSER_PREVIEW',
            variant: 'original',
          },
        },
        select: { id: true },
      });
      if (existing !== null) {
        return;
      }
      await database.assetRendition.create({
        data: {
          assetVersionId,
          storageObjectId: version.storageObject.id,
          type: 'BROWSER_PREVIEW',
          variant: 'original',
          status: 'AVAILABLE',
        },
      });
      await database.storageObject.update({
        where: { id: version.storageObject.id },
        data: { referenceCount: { increment: 1 } },
      });
    });
  }

  private async restoreFallback(
    database: Prisma.TransactionClient,
    version: Awaited<ReturnType<AssetProcessingService['version']>>,
  ): Promise<void> {
    if (version.asset.currentVersionId !== version.id) {
      return;
    }
    const fallback = await database.assetVersion.findFirst({
      where: {
        assetId: version.asset.id,
        id: { not: version.id },
        status: 'AVAILABLE',
        scanStatus: { in: ['CLEAN', 'SKIPPED'] },
      },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, mimeType: true },
    });
    await database.asset.update({
      where: { id: version.asset.id },
      data: {
        currentVersionId: fallback?.id ?? null,
        ...(fallback === null ? {} : { mimeType: fallback.mimeType }),
      },
    });
    await database.resourceNode.update({
      where: { id: version.asset.node.id },
      data: {
        status: fallback === null ? 'QUARANTINED' : 'ACTIVE',
        lockVersion: { increment: 1 },
      },
    });
  }

  private async notifyPartialFailure(
    database: Prisma.TransactionClient,
    job: ClaimedProcessingJob,
    error: unknown,
  ): Promise<void> {
    const version = await this.version(database, job.assetVersionId);
    await database.notification.create({
      data: {
        userId: version.createdById,
        type: 'asset.processing.partial-failure',
        payload: {
          assetId: version.asset.id,
          nodeId: version.asset.node.id,
          versionId: version.id,
          processingJobId: job.id,
          jobType: job.jobType,
          message: this.safeError(error),
        },
      },
    });
  }

  private async assertActiveLease(
    database: Prisma.TransactionClient,
    job: ClaimedProcessingJob,
  ): Promise<void> {
    const leases = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "processing_jobs"
      WHERE "id" = ${job.id}::uuid
        AND "status" = 'RUNNING'
        AND "locked_by" = ${job.lockedBy}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
      FOR UPDATE
    `);
    if (leases.length !== 1) {
      throw new Error(`Processing job ${job.id} lease was lost`);
    }
  }

  private async auditAndNotify(
    database: Prisma.TransactionClient,
    version: Awaited<ReturnType<AssetProcessingService['version']>>,
    type: string,
    payload: Prisma.InputJsonObject,
  ): Promise<void> {
    await database.auditEvent.create({
      data: {
        tenantId: version.asset.node.space.tenantId,
        action: type,
        resourceType: 'ASSET_VERSION',
        resourceId: version.id,
        result: type.endsWith('available') ? 'SUCCEEDED' : 'FAILED',
        details: payload,
      },
    });
    await database.notification.create({
      data: { userId: version.createdById, type, payload },
    });
  }

  private version(database: Prisma.TransactionClient | PrismaService, id: string) {
    return database.assetVersion.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        versionNumber: true,
        status: true,
        scanStatus: true,
        mimeType: true,
        createdById: true,
        storageObject: { select: { id: true, objectKey: true } },
        asset: {
          select: {
            id: true,
            currentVersionId: true,
            node: { select: { id: true, space: { select: { tenantId: true } } } },
          },
        },
      },
    });
  }

  private browserReadable(mimeType: string): boolean {
    return (
      mimeType === 'application/pdf' ||
      mimeType.startsWith('image/') ||
      mimeType.startsWith('audio/') ||
      mimeType.startsWith('video/') ||
      mimeType.startsWith('text/')
    );
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
  }
}
