import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';

import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { StorageReconciliationPageQueryDto } from './dto/maintenance.dto.js';

type StorageReconciliationItem =
  | {
      id: string;
      issueType: 'DATABASE_OBJECT_MISSING';
      storageObjectId: string;
      expectedSizeBytes: string;
      databaseCreatedAt: Date;
    }
  | {
      id: string;
      issueType: 'STORAGE_OBJECT_UNKNOWN';
      objectFingerprint: string;
      observedSizeBytes: string;
      lastModifiedAt: Date;
    };

const databaseBatchSize = 250;
const storageBatchSize = 250;
const statConcurrency = 8;
const knownUploadStatuses = ['CREATED', 'UPLOADING'] as const;
const pendingDeletionStatuses = ['PENDING', 'RUNNING', 'FAILED', 'DEAD'] as const;

@Injectable()
export class StorageReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  async report(
    actor: AuthenticatedUser,
    query: StorageReconciliationPageQueryDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const candidates: StorageReconciliationItem[] = [];
    const summary = {
      databaseObjects: 0,
      storageObjects: 0,
      missingObjects: 0,
      unknownObjects: 0,
    };
    const collect = (item: StorageReconciliationItem) => {
      if (query.cursor !== undefined && item.id <= query.cursor) {
        return;
      }
      candidates.push(item);
      candidates.sort((left, right) => left.id.localeCompare(right.id));
      if (candidates.length > query.limit + 1) {
        candidates.pop();
      }
    };

    await this.reconcileDatabaseObjects(actor.tenantId, summary, collect);
    await this.reconcileStorageObjects(actor.tenantId, summary, collect);

    const items = candidates.slice(0, query.limit);
    const nextCursor =
      candidates.length > query.limit && items.length > 0 ? items[items.length - 1]!.id : null;
    await this.prisma.auditEvent.create({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'storage.reconciliation.read',
        resourceType: 'TENANT',
        resourceId: actor.tenantId,
        result: 'SUCCEEDED',
        ipAddress: metadata.ipAddress ?? null,
        userAgent: metadata.userAgent ?? null,
        requestId: metadata.requestId ?? null,
        details: {
          ...summary,
          returnedItems: items.length,
          hasNextPage: nextCursor !== null,
        },
      },
    });
    return { generatedAt: new Date(), summary, items, nextCursor };
  }

  private async reconcileDatabaseObjects(
    tenantId: string,
    summary: { databaseObjects: number; missingObjects: number },
    collect: (item: StorageReconciliationItem) => void,
  ): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const objects = await this.prisma.storageObject.findMany({
        where: this.tenantStorageObjectWhere(tenantId),
        orderBy: { id: 'asc' },
        take: databaseBatchSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        select: {
          id: true,
          bucket: true,
          objectKey: true,
          sizeBytes: true,
          createdAt: true,
        },
      });
      summary.databaseObjects += objects.length;
      for (let start = 0; start < objects.length; start += statConcurrency) {
        const batch = objects.slice(start, start + statConcurrency);
        await Promise.all(
          batch.map(async (object) => {
            let exists: boolean;
            try {
              exists = await this.storage.objectExists(object.bucket, object.objectKey);
            } catch {
              throw this.storageUnavailable();
            }
            if (exists) {
              return;
            }
            summary.missingObjects += 1;
            collect({
              id: this.issueId('DATABASE_OBJECT_MISSING', object.id),
              issueType: 'DATABASE_OBJECT_MISSING',
              storageObjectId: object.id,
              expectedSizeBytes: object.sizeBytes.toString(),
              databaseCreatedAt: object.createdAt,
            });
          }),
        );
      }
      if (objects.length < databaseBatchSize) {
        return;
      }
      cursor = objects[objects.length - 1]!.id;
    }
  }

  private async reconcileStorageObjects(
    tenantId: string,
    summary: { storageObjects: number; unknownObjects: number },
    collect: (item: StorageReconciliationItem) => void,
  ): Promise<void> {
    let batch: Array<{ objectKey: string; sizeBytes: bigint; lastModified: Date }> = [];
    const flush = async () => {
      if (batch.length === 0) {
        return;
      }
      const objectKeys = batch.map((object) => object.objectKey);
      const bucket = this.storage.bucketName();
      const [registeredObjects, uploadSessions, deletionJobs] = await Promise.all([
        this.prisma.storageObject.findMany({
          where: { bucket, objectKey: { in: objectKeys } },
          select: { objectKey: true },
        }),
        this.prisma.uploadSession.findMany({
          where: {
            space: { tenantId },
            status: { in: [...knownUploadStatuses] },
            objectKey: { in: objectKeys },
          },
          select: { objectKey: true },
        }),
        this.prisma.maintenanceJob.findMany({
          where: {
            tenantId,
            jobType: 'DELETE_STORAGE_OBJECT',
            status: { in: [...pendingDeletionStatuses] },
            AND: [{ payload: { path: ['bucket'], equals: bucket } }],
            OR: objectKeys.map((objectKey) => ({
              payload: { path: ['objectKey'], equals: objectKey },
            })),
          },
          select: { payload: true },
        }),
      ]);
      const knownKeys = new Set([
        ...registeredObjects.map((object) => object.objectKey),
        ...uploadSessions.map((session) => session.objectKey),
        ...deletionJobs.flatMap(({ payload }) => {
          const objectKey = this.deletionObjectKey(payload, bucket);
          return objectKey === null ? [] : [objectKey];
        }),
      ]);
      for (const object of batch) {
        if (knownKeys.has(object.objectKey)) {
          continue;
        }
        summary.unknownObjects += 1;
        const fingerprint = this.issueId('STORAGE_OBJECT_UNKNOWN', object.objectKey);
        collect({
          id: fingerprint,
          issueType: 'STORAGE_OBJECT_UNKNOWN',
          objectFingerprint: fingerprint,
          observedSizeBytes: object.sizeBytes.toString(),
          lastModifiedAt: object.lastModified,
        });
      }
      batch = [];
    };

    const objects = this.storage.listTenantObjects(tenantId)[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<{ objectKey: string; sizeBytes: bigint; lastModified: Date }>;
      try {
        next = await objects.next();
      } catch {
        throw this.storageUnavailable();
      }
      if (next.done) {
        break;
      }
      summary.storageObjects += 1;
      batch.push(next.value);
      if (batch.length >= storageBatchSize) {
        await flush();
      }
    }
    await flush();
  }

  private tenantStorageObjectWhere(tenantId: string) {
    return {
      OR: [
        { objectKey: { startsWith: this.tenantObjectPrefix(tenantId) } },
        { sourceVersions: { some: { asset: { node: { space: { tenantId } } } } } },
        {
          renditions: {
            some: { assetVersion: { asset: { node: { space: { tenantId } } } } },
          },
        },
      ],
    };
  }

  private tenantObjectPrefix(tenantId: string): string {
    return `tenants/${tenantId}/`;
  }

  private deletionObjectKey(payload: unknown, expectedBucket: string): string | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    return record['bucket'] === expectedBucket && typeof record['objectKey'] === 'string'
      ? record['objectKey']
      : null;
  }

  private issueId(issueType: StorageReconciliationItem['issueType'], value: string): string {
    return createHash('sha256').update(issueType).update('\0').update(value).digest('hex');
  }

  private storageUnavailable(): ApiException {
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'INTERNAL_ERROR',
      '对象存储暂时不可用，无法生成对账报告',
    );
  }
}
