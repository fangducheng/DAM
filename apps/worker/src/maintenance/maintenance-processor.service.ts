import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '@dam/database';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { ClaimedMaintenanceJob } from './maintenance-job.types.js';

interface LockedDeletionBatch {
  id: string;
  tenantId: string;
  spaceId: string;
  status: string;
  purgeAt: Date;
  deletedById: string | null;
  rootName: string;
  sourceBytes: bigint;
  itemCount: number;
}

@Injectable()
export class MaintenanceProcessorService {
  private readonly readRetentionDays: number;
  private readonly archivedRetentionDays: number;
  private readonly completedJobRetentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    config: ConfigService,
  ) {
    this.readRetentionDays = config.getOrThrow<number>('NOTIFICATION_READ_RETENTION_DAYS');
    this.archivedRetentionDays = config.getOrThrow<number>('NOTIFICATION_ARCHIVED_RETENTION_DAYS');
    this.completedJobRetentionDays = config.getOrThrow<number>('COMPLETED_JOB_RETENTION_DAYS');
  }

  async process(job: ClaimedMaintenanceJob): Promise<void> {
    switch (job.jobType) {
      case 'EXPIRE_UPLOAD_SESSION':
        await this.expireUpload(job);
        return;
      case 'RETENTION_WARNING':
        await this.sendRetentionWarning(job);
        return;
      case 'PURGE_DELETION_BATCH':
        await this.purgeDeletionBatch(job);
        return;
      case 'DELETE_STORAGE_OBJECT':
        await this.deleteStorageObject(job);
        return;
      case 'PRUNE_NOTIFICATIONS':
        await this.pruneNotifications(job);
        return;
      case 'PRUNE_COMPLETED_JOBS':
        await this.pruneCompletedJobs(job);
        return;
    }
  }

  async recordFailure(
    database: Prisma.TransactionClient,
    job: ClaimedMaintenanceJob,
    terminal: boolean,
    error: unknown,
  ): Promise<void> {
    if (!terminal) return;
    const message = this.safeError(error);
    if (job.jobType === 'PURGE_DELETION_BATCH' && job.targetId !== null) {
      const changed = await database.deletionBatch.updateMany({
        where: {
          id: job.targetId,
          status: { in: ['RETAINED', 'PURGE_REQUESTED', 'PURGING'] },
        },
        data: { status: 'FAILED', errorMessage: message },
      });
      if (changed.count > 0) {
        await database.auditEvent.create({
          data: {
            tenantId: job.tenantId,
            action: 'resource.purge.failed',
            resourceType: 'DELETION_BATCH',
            resourceId: job.targetId,
            result: 'FAILED',
            details: { maintenanceJobId: job.id, message },
          },
        });
      }
      return;
    }
    if (job.jobType === 'DELETE_STORAGE_OBJECT') {
      await database.auditEvent.create({
        data: {
          tenantId: job.tenantId,
          action: 'storage.delete.failed',
          resourceType: 'STORAGE_OBJECT',
          resourceId: job.targetId,
          result: 'FAILED',
          details: { maintenanceJobId: job.id, message },
        },
      });
    }
  }

  private async expireUpload(job: ClaimedMaintenanceJob): Promise<void> {
    if (job.targetId === null) throw new Error('Upload expiration job has no target');
    const upload = await this.prisma.$transaction(async (database) => {
      await this.assertActiveLease(database, job);
      const locked = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "upload_sessions"
        WHERE "id" = ${job.targetId}::uuid
        FOR UPDATE
      `);
      if (locked.length === 0) return null;
      const session = await database.uploadSession.findUniqueOrThrow({
        where: { id: job.targetId! },
        select: {
          id: true,
          status: true,
          expiresAt: true,
          objectKey: true,
          uploadId: true,
          initiatedById: true,
          space: { select: { tenantId: true } },
        },
      });
      if (session.status === 'COMPLETED' || session.status === 'ABORTED') return null;
      if (session.expiresAt.getTime() > Date.now()) throw new Error('Upload session is not due');
      if (session.status !== 'EXPIRED') {
        await database.uploadSession.update({
          where: { id: session.id },
          data: { status: 'EXPIRED' },
        });
        await database.auditEvent.create({
          data: {
            tenantId: session.space.tenantId,
            action: 'upload.expired',
            resourceType: 'UPLOAD_SESSION',
            resourceId: session.id,
            result: 'SUCCEEDED',
          },
        });
      }
      return { objectKey: session.objectKey, uploadId: session.uploadId };
    });
    if (upload !== null && upload.uploadId !== null) {
      await this.storage.abortMultipart(upload.objectKey, upload.uploadId);
    }
  }

  private async sendRetentionWarning(job: ClaimedMaintenanceJob): Promise<void> {
    if (job.targetId === null) throw new Error('Retention warning job has no target');
    await this.prisma.$transaction(async (database) => {
      await this.assertActiveLease(database, job);
      const batch = await database.deletionBatch.findUnique({
        where: { id: job.targetId! },
        select: {
          id: true,
          status: true,
          deletedById: true,
          rootName: true,
          purgeAt: true,
        },
      });
      if (batch === null || batch.status !== 'RETAINED' || batch.deletedById === null) return;
      const payload = this.payloadRecord(job.payload);
      const daysRemaining = payload['daysRemaining'];
      if (daysRemaining !== 1 && daysRemaining !== 7) {
        throw new Error('Retention warning has an invalid deadline');
      }
      const existing = await database.notification.findFirst({
        where: {
          userId: batch.deletedById,
          type: 'resource.retention.warning',
          payload: { path: ['maintenanceJobId'], equals: job.id },
        },
        select: { id: true },
      });
      if (existing !== null) return;
      await database.notification.create({
        data: {
          userId: batch.deletedById,
          type: 'resource.retention.warning',
          payload: {
            maintenanceJobId: job.id,
            deletionBatchId: batch.id,
            name: batch.rootName,
            daysRemaining,
            purgeAt: batch.purgeAt.toISOString(),
          },
        },
      });
    });
  }

  private async purgeDeletionBatch(job: ClaimedMaintenanceJob): Promise<void> {
    if (job.targetId === null) throw new Error('Purge job has no target');
    await this.prisma.$transaction(
      async (database) => {
        await this.assertActiveLease(database, job);
        const batches = await database.$queryRaw<LockedDeletionBatch[]>(Prisma.sql`
          SELECT
            "id",
            "tenant_id" AS "tenantId",
            "space_id" AS "spaceId",
            "status"::text AS "status",
            "purge_at" AS "purgeAt",
            "deleted_by_id" AS "deletedById",
            "root_name" AS "rootName",
            "source_bytes" AS "sourceBytes",
            "item_count" AS "itemCount"
          FROM "deletion_batches"
          WHERE "id" = ${job.targetId}::uuid
          FOR UPDATE
        `);
        const batch = batches[0];
        if (batch === undefined || ['PURGED', 'RESTORED', 'SUPERSEDED'].includes(batch.status)) {
          return;
        }
        if (!['RETAINED', 'PURGE_REQUESTED', 'PURGING'].includes(batch.status)) {
          throw new Error(`Deletion batch is not purgeable from ${batch.status}`);
        }
        if (batch.status === 'RETAINED' && batch.purgeAt.getTime() > Date.now()) {
          throw new Error('Deletion batch is not due');
        }
        const versions = await database.assetVersion.findMany({
          where: { asset: { node: { deletionBatchId: batch.id } } },
          select: {
            sizeBytes: true,
            storageObject: { select: { id: true, bucket: true, objectKey: true } },
          },
        });
        const renditions = await database.assetRendition.findMany({
          where: { assetVersion: { asset: { node: { deletionBatchId: batch.id } } } },
          select: { storageObject: { select: { id: true, bucket: true, objectKey: true } } },
        });
        const releaseBytes = versions.reduce((total, version) => total + version.sizeBytes, 0n);
        if (releaseBytes !== batch.sourceBytes) {
          throw new Error('Deletion batch source-byte snapshot does not match stored versions');
        }
        const spaces = await database.$queryRaw<Array<{ usedBytes: bigint }>>(Prisma.sql`
          SELECT "used_bytes" AS "usedBytes"
          FROM "spaces"
          WHERE "id" = ${batch.spaceId}::uuid
            AND "tenant_id" = ${batch.tenantId}::uuid
          FOR UPDATE
        `);
        const space = spaces[0];
        if (space === undefined || space.usedBytes < releaseBytes) {
          throw new Error('Space quota would underflow during permanent deletion');
        }
        await database.deletionBatch.update({
          where: { id: batch.id },
          data: { status: 'PURGING', errorMessage: null },
        });
        await database.resourceNode.updateMany({
          where: { deletionBatchId: batch.id },
          data: { parentId: null, status: 'PURGING' },
        });
        const removed = await database.resourceNode.deleteMany({
          where: { deletionBatchId: batch.id },
        });
        if (removed.count !== batch.itemCount) {
          throw new Error('Deletion batch item count changed before purge');
        }
        await database.space.update({
          where: { id: batch.spaceId },
          data: { usedBytes: { decrement: releaseBytes } },
        });
        const affectedObjects = new Map(
          [...versions, ...renditions].map(({ storageObject }) => [
            storageObject.id,
            storageObject,
          ]),
        );
        for (const storageObject of affectedObjects.values()) {
          const current = await database.storageObject.findUnique({
            where: { id: storageObject.id },
            select: { _count: { select: { sourceVersions: true, renditions: true } } },
          });
          if (current === null) continue;
          const referenceCount = current._count.sourceVersions + current._count.renditions;
          if (referenceCount > 0) {
            await database.storageObject.update({
              where: { id: storageObject.id },
              data: { referenceCount },
            });
            continue;
          }
          await database.storageObject.delete({ where: { id: storageObject.id } });
          await database.maintenanceJob.createMany({
            data: [
              {
                tenantId: batch.tenantId,
                spaceId: batch.spaceId,
                jobType: 'DELETE_STORAGE_OBJECT',
                idempotencyKey: `storage:${storageObject.id}:delete`,
                targetId: storageObject.id,
                payload: { bucket: storageObject.bucket, objectKey: storageObject.objectKey },
              },
            ],
            skipDuplicates: true,
          });
        }
        const purgedAt = new Date();
        await database.deletionBatch.update({
          where: { id: batch.id },
          data: {
            status: 'PURGED',
            purgedAt,
            releasedBytes: releaseBytes,
            errorMessage: null,
          },
        });
        await database.auditEvent.create({
          data: {
            tenantId: batch.tenantId,
            action: 'resource.purge.completed',
            resourceType: 'DELETION_BATCH',
            resourceId: batch.id,
            result: 'SUCCEEDED',
            details: {
              itemCount: removed.count,
              releasedBytes: releaseBytes.toString(),
              storageObjectCount: affectedObjects.size,
            },
          },
        });
        if (batch.deletedById !== null) {
          await database.notification.create({
            data: {
              userId: batch.deletedById,
              type: 'resource.purge.completed',
              payload: {
                deletionBatchId: batch.id,
                name: batch.rootName,
                releasedBytes: releaseBytes.toString(),
              },
            },
          });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async deleteStorageObject(job: ClaimedMaintenanceJob): Promise<void> {
    const payload = this.payloadRecord(job.payload);
    const bucket = payload['bucket'];
    const objectKey = payload['objectKey'];
    if (typeof bucket !== 'string' || typeof objectKey !== 'string') {
      throw new Error('Storage deletion payload is invalid');
    }
    await this.storage.removeObject(bucket, objectKey);
  }

  private async pruneNotifications(job: ClaimedMaintenanceJob): Promise<void> {
    if (job.tenantId === null) throw new Error('Notification pruning job has no tenant');
    await this.prisma.$transaction(async (database) => {
      await this.assertActiveLease(database, job);
      const dayMs = 24 * 60 * 60 * 1_000;
      const [read, archived] = await Promise.all([
        database.notification.deleteMany({
          where: {
            user: { tenantId: job.tenantId! },
            status: 'READ',
            readAt: { lt: new Date(Date.now() - this.readRetentionDays * dayMs) },
          },
        }),
        database.notification.deleteMany({
          where: {
            user: { tenantId: job.tenantId! },
            status: 'ARCHIVED',
            archivedAt: { lt: new Date(Date.now() - this.archivedRetentionDays * dayMs) },
          },
        }),
      ]);
      if (read.count + archived.count > 0) {
        await database.auditEvent.create({
          data: {
            tenantId: job.tenantId,
            action: 'maintenance.notifications.pruned',
            resourceType: 'TENANT',
            resourceId: job.tenantId,
            result: 'SUCCEEDED',
            details: { readCount: read.count, archivedCount: archived.count },
          },
        });
      }
    });
  }

  private async pruneCompletedJobs(job: ClaimedMaintenanceJob): Promise<void> {
    if (job.tenantId === null) throw new Error('Job pruning task has no tenant');
    await this.prisma.$transaction(async (database) => {
      await this.assertActiveLease(database, job);
      const cutoff = new Date(Date.now() - this.completedJobRetentionDays * 24 * 60 * 60 * 1_000);
      const [processing, maintenance] = await Promise.all([
        database.processingJob.deleteMany({
          where: {
            status: 'SUCCEEDED',
            completedAt: { lt: cutoff },
            assetVersion: { asset: { node: { space: { tenantId: job.tenantId! } } } },
          },
        }),
        database.maintenanceJob.deleteMany({
          where: {
            tenantId: job.tenantId,
            id: { not: job.id },
            status: { in: ['SUCCEEDED', 'CANCELLED'] },
            completedAt: { lt: cutoff },
          },
        }),
      ]);
      if (processing.count + maintenance.count > 0) {
        await database.auditEvent.create({
          data: {
            tenantId: job.tenantId,
            action: 'maintenance.jobs.pruned',
            resourceType: 'TENANT',
            resourceId: job.tenantId,
            result: 'SUCCEEDED',
            details: {
              processingCount: processing.count,
              maintenanceCount: maintenance.count,
            },
          },
        });
      }
    });
  }

  private async assertActiveLease(
    database: Prisma.TransactionClient,
    job: ClaimedMaintenanceJob,
  ): Promise<void> {
    const leases = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "maintenance_jobs"
      WHERE "id" = ${job.id}::uuid
        AND "status" = 'RUNNING'
        AND "locked_by" = ${job.lockedBy}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
      FOR UPDATE
    `);
    if (leases.length !== 1) throw new Error(`Maintenance job ${job.id} lease was lost`);
  }

  private payloadRecord(payload: Prisma.JsonValue): Prisma.JsonObject {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('Maintenance job payload must be an object');
    }
    return payload;
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
  }
}
