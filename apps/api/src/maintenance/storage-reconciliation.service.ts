import { HttpStatus, Injectable } from '@nestjs/common';

import { Prisma } from '@dam/database';
import type { AuthenticatedUser } from '@dam/contracts';

import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type {
  CreateStorageReconciliationRunDto,
  StorageReconciliationIssuePageQueryDto,
  StorageReconciliationRunPageQueryDto,
} from './dto/maintenance.dto.js';

const activeStatuses = ['QUEUED', 'RUNNING', 'RETRYING'] as const;

const safeRunSelect = {
  id: true,
  sourceRunId: true,
  requestedBy: { select: { id: true, displayName: true } },
  status: true,
  phase: true,
  databaseObjects: true,
  storageObjects: true,
  missingObjects: true,
  unknownObjects: true,
  cutoffAt: true,
  lastCheckpointAt: true,
  startedAt: true,
  completedAt: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class StorageReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(
    actor: AuthenticatedUser,
    input: CreateStorageReconciliationRunDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    try {
      return await this.prisma.$transaction(async (database) => {
        if (input.sourceRunId !== undefined) {
          const source = await database.storageReconciliationRun.findFirst({
            where: { id: input.sourceRunId, tenantId: actor.tenantId },
            select: { id: true },
          });
          if (source === null) throw this.runNotFound();
        }

        const active = await database.storageReconciliationRun.findFirst({
          where: { tenantId: actor.tenantId, status: { in: [...activeStatuses] } },
          select: { id: true },
        });
        if (active !== null) throw this.activeRunConflict();

        const run = await database.storageReconciliationRun.create({
          data: {
            tenantId: actor.tenantId,
            requestedById: actor.userId,
            sourceRunId: input.sourceRunId ?? null,
          },
          select: safeRunSelect,
        });
        await database.maintenanceJob.create({
          data: {
            tenantId: actor.tenantId,
            jobType: 'RECONCILE_STORAGE_STEP',
            idempotencyKey: `reconciliation:${run.id}:step:0`,
            targetId: run.id,
            payload: { phase: 'DATABASE_SCAN', checkpointVersion: 0 },
          },
          select: { id: true },
        });
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'storage.reconciliation.requested',
            resourceType: 'STORAGE_RECONCILIATION_RUN',
            resourceId: run.id,
            result: 'SUCCEEDED',
            ipAddress: metadata.ipAddress ?? null,
            userAgent: metadata.userAgent ?? null,
            requestId: metadata.requestId ?? null,
            ...(input.sourceRunId === undefined
              ? {}
              : { details: { sourceRunId: input.sourceRunId } }),
          },
        });
        return run;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw this.activeRunConflict();
      }
      throw error;
    }
  }

  async listRuns(actor: AuthenticatedUser, query: StorageReconciliationRunPageQueryDto) {
    const records = await this.prisma.storageReconciliationRun.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.cursor === undefined ? {} : { id: { lt: query.cursor } }),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: safeRunSelect,
    });
    const items = records.slice(0, query.limit);
    return {
      items,
      nextCursor:
        records.length > query.limit && items.length > 0 ? items[items.length - 1]!.id : null,
    };
  }

  async getRun(actor: AuthenticatedUser, runId: string) {
    const run = await this.prisma.storageReconciliationRun.findFirst({
      where: { id: runId, tenantId: actor.tenantId },
      select: safeRunSelect,
    });
    if (run === null) throw this.runNotFound();
    return run;
  }

  async listIssues(
    actor: AuthenticatedUser,
    runId: string,
    query: StorageReconciliationIssuePageQueryDto,
  ) {
    const run = await this.prisma.storageReconciliationRun.findFirst({
      where: { id: runId, tenantId: actor.tenantId },
      select: {
        id: true,
        status: true,
        databaseObjects: true,
        storageObjects: true,
        missingObjects: true,
        unknownObjects: true,
        completedAt: true,
      },
    });
    if (run === null) throw this.runNotFound();
    if (run.status !== 'SUCCEEDED') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'VERSION_CONFLICT',
        '对账结果尚未完成，请稍后刷新',
      );
    }

    const records = await this.prisma.storageReconciliationIssue.findMany({
      where: {
        runId,
        tenantId: actor.tenantId,
        ...(query.issueType === undefined ? {} : { issueType: query.issueType }),
        ...(query.cursor === undefined ? {} : { issueKey: { gt: query.cursor } }),
      },
      orderBy: { issueKey: 'asc' },
      take: query.limit + 1,
      select: {
        issueKey: true,
        issueType: true,
        storageObjectId: true,
        objectFingerprint: true,
        expectedSizeBytes: true,
        observedSizeBytes: true,
        databaseCreatedAt: true,
        lastModifiedAt: true,
      },
    });
    const page = records.slice(0, query.limit);
    const items = page.map((issue) =>
      issue.issueType === 'DATABASE_OBJECT_MISSING'
        ? {
            id: issue.issueKey,
            issueType: issue.issueType,
            storageObjectId: issue.storageObjectId!,
            expectedSizeBytes: issue.expectedSizeBytes!.toString(),
            databaseCreatedAt: issue.databaseCreatedAt!,
          }
        : {
            id: issue.issueKey,
            issueType: issue.issueType,
            objectFingerprint: issue.objectFingerprint!,
            observedSizeBytes: issue.observedSizeBytes!.toString(),
            lastModifiedAt: issue.lastModifiedAt!,
          },
    );
    return {
      runId: run.id,
      generatedAt: run.completedAt,
      summary: {
        databaseObjects: run.databaseObjects,
        storageObjects: run.storageObjects,
        missingObjects: run.missingObjects,
        unknownObjects: run.unknownObjects,
      },
      items,
      nextCursor:
        records.length > query.limit && page.length > 0 ? page[page.length - 1]!.issueKey : null,
    };
  }

  private activeRunConflict(): ApiException {
    return new ApiException(
      HttpStatus.CONFLICT,
      'VERSION_CONFLICT',
      '当前已有存储对账任务正在执行，请刷新后查看进度',
    );
  }

  private runNotFound(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'RESOURCE_NOT_FOUND',
      '存储对账记录不存在或你无权查看',
    );
  }
}
