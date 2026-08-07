import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { Prisma } from '@dam/database';

import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { ClaimedMaintenanceJob } from './maintenance-job.types.js';
import { MaintenanceQueueService } from './maintenance-queue.service.js';

type ReconciliationPhase = 'DATABASE_SCAN' | 'STORAGE_SCAN' | 'FINALIZING' | 'COMPLETE';
type ActiveReconciliationStatus = 'QUEUED' | 'RUNNING' | 'RETRYING';

interface StepExpectation {
  phase: ReconciliationPhase;
  checkpointVersion: number;
}

interface ReconciliationRunCheckpoint {
  id: string;
  tenantId: string;
  requestedById: string | null;
  status: 'QUEUED' | 'RUNNING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED';
  phase: ReconciliationPhase;
  checkpointVersion: number;
  databaseCursor: string | null;
  storageCursor: string | null;
  cutoffAt: Date;
  databaseObjects: number;
  storageObjects: number;
  missingObjects: number;
  unknownObjects: number;
  startedAt: Date | null;
}

interface CheckpointChange {
  phase: Exclude<ReconciliationPhase, 'COMPLETE'>;
  databaseCursor: string | null;
  storageCursor: string | null;
  databaseObjects: number;
  storageObjects: number;
  missingObjects: number;
  unknownObjects: number;
  issues: Prisma.StorageReconciliationIssueCreateManyInput[];
}

const databaseBatchSize = 64;
const storageBatchSize = 250;
const statConcurrency = 8;
const activeStatuses: ActiveReconciliationStatus[] = ['QUEUED', 'RUNNING', 'RETRYING'];
const knownUploadStatuses = ['CREATED', 'UPLOADING'] as const;
const pendingDeletionStatuses = ['PENDING', 'RUNNING', 'FAILED', 'DEAD'] as const;
const invalidPayloadFailure = {
  code: 'RECONCILIATION_INVALID_PAYLOAD',
  message: 'Storage reconciliation job payload is invalid',
} as const;

export class StorageReconciliationStepError extends Error {
  constructor(
    readonly code: 'RECONCILIATION_STEP_FAILED' | 'RECONCILIATION_LEASE_LOST',
    message: string,
  ) {
    super(message);
    this.name = 'StorageReconciliationStepError';
  }
}

@Injectable()
export class StorageReconciliationProcessorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly queue: MaintenanceQueueService,
  ) {}

  async process(job: ClaimedMaintenanceJob): Promise<void> {
    try {
      await this.processStep(job);
    } catch (error) {
      if (error instanceof StorageReconciliationStepError) throw error;
      if (error instanceof Error && error.message.includes('lease was lost')) {
        throw new StorageReconciliationStepError(
          'RECONCILIATION_LEASE_LOST',
          'Storage reconciliation lease was lost',
        );
      }
      throw new StorageReconciliationStepError(
        'RECONCILIATION_STEP_FAILED',
        'Storage reconciliation step failed',
      );
    }
  }

  async recordFailure(
    database: Prisma.TransactionClient,
    job: ClaimedMaintenanceJob,
    terminal: boolean,
    error: unknown,
  ): Promise<void> {
    if (job.targetId === null || job.tenantId === null) return;
    const parsedExpectation = this.tryExpectation(job.payload);
    const expectation = parsedExpectation?.phase === 'COMPLETE' ? null : parsedExpectation;
    const failure = expectation === null ? invalidPayloadFailure : this.safeFailure(error);
    let checkpoint: StepExpectation;
    if (expectation === null) {
      const currentRun = await database.storageReconciliationRun.findFirst({
        where: {
          id: job.targetId,
          tenantId: job.tenantId,
          status: { in: activeStatuses },
        },
        select: { phase: true, checkpointVersion: true },
      });
      if (
        currentRun === null ||
        job.idempotencyKey !== this.stepIdempotencyKey(job.targetId, currentRun.checkpointVersion)
      ) {
        return;
      }
      checkpoint = currentRun;
    } else {
      checkpoint = expectation;
    }
    const completedAt = terminal ? new Date() : null;
    const changed = await database.storageReconciliationRun.updateMany({
      where: {
        id: job.targetId,
        tenantId: job.tenantId,
        status: { in: activeStatuses },
        phase: checkpoint.phase,
        checkpointVersion: checkpoint.checkpointVersion,
      },
      data: {
        status: terminal ? 'FAILED' : 'RETRYING',
        errorCode: failure.code,
        errorMessage: failure.message,
        completedAt,
      },
    });
    if (!terminal || changed.count === 0) return;
    const run = await database.storageReconciliationRun.findUnique({
      where: { id: job.targetId },
      select: {
        requestedById: true,
        databaseObjects: true,
        storageObjects: true,
        missingObjects: true,
        unknownObjects: true,
      },
    });
    if (run === null) return;
    await database.auditEvent.create({
      data: {
        tenantId: job.tenantId,
        actorUserId: run.requestedById,
        action: 'storage.reconciliation.failed',
        resourceType: 'STORAGE_RECONCILIATION_RUN',
        resourceId: job.targetId,
        result: 'FAILED',
        details: {
          maintenanceJobId: job.id,
          errorCode: failure.code,
          phase: expectation?.phase ?? 'INVALID_PAYLOAD',
          databaseObjects: run.databaseObjects,
          storageObjects: run.storageObjects,
          missingObjects: run.missingObjects,
          unknownObjects: run.unknownObjects,
        },
      },
    });
  }

  private async processStep(job: ClaimedMaintenanceJob): Promise<void> {
    if (
      job.jobType !== 'RECONCILE_STORAGE_STEP' ||
      job.targetId === null ||
      job.tenantId === null
    ) {
      throw new Error('Storage reconciliation job is invalid');
    }
    const expectation = this.expectation(job.payload);
    const run = await this.prisma.storageReconciliationRun.findFirst({
      where: { id: job.targetId, tenantId: job.tenantId },
      select: {
        id: true,
        tenantId: true,
        requestedById: true,
        status: true,
        phase: true,
        checkpointVersion: true,
        databaseCursor: true,
        storageCursor: true,
        cutoffAt: true,
        databaseObjects: true,
        storageObjects: true,
        missingObjects: true,
        unknownObjects: true,
        startedAt: true,
      },
    });
    if (
      run === null ||
      run.phase !== expectation.phase ||
      run.checkpointVersion !== expectation.checkpointVersion ||
      run.status === 'SUCCEEDED' ||
      run.status === 'FAILED'
    ) {
      return;
    }
    if (run.status === 'QUEUED' || run.status === 'RETRYING') {
      const started = await this.prisma.storageReconciliationRun.updateMany({
        where: {
          id: run.id,
          tenantId: run.tenantId,
          phase: expectation.phase,
          checkpointVersion: expectation.checkpointVersion,
          status: run.status,
        },
        data: {
          status: 'RUNNING',
          startedAt: run.startedAt ?? new Date(),
          completedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (started.count !== 1) return;
    }

    await this.queue.renew(job);
    switch (expectation.phase) {
      case 'DATABASE_SCAN':
        await this.processDatabasePage(job, run, expectation);
        return;
      case 'STORAGE_SCAN':
        await this.processStoragePage(job, run, expectation);
        return;
      case 'FINALIZING':
        await this.finalize(job, run, expectation);
        return;
      case 'COMPLETE':
        return;
    }
  }

  private async processDatabasePage(
    job: ClaimedMaintenanceJob,
    run: ReconciliationRunCheckpoint,
    expectation: StepExpectation,
  ): Promise<void> {
    const objects = await this.prisma.storageObject.findMany({
      where: {
        createdAt: { lte: run.cutoffAt },
        ...(run.databaseCursor === null ? {} : { id: { gt: run.databaseCursor } }),
        OR: [
          { objectKey: { startsWith: this.tenantPrefix(run.tenantId) } },
          { sourceVersions: { some: { asset: { node: { space: { tenantId: run.tenantId } } } } } },
          {
            renditions: {
              some: {
                assetVersion: { asset: { node: { space: { tenantId: run.tenantId } } } },
              },
            },
          },
        ],
      },
      orderBy: { id: 'asc' },
      take: databaseBatchSize,
      select: {
        id: true,
        bucket: true,
        objectKey: true,
        sizeBytes: true,
        createdAt: true,
      },
    });
    const issues: Prisma.StorageReconciliationIssueCreateManyInput[] = [];
    for (let start = 0; start < objects.length; start += statConcurrency) {
      await this.queue.renew(job);
      const batch = objects.slice(start, start + statConcurrency);
      const existence = await Promise.all(
        batch.map((object) => this.storage.objectExists(object.bucket, object.objectKey)),
      );
      for (let index = 0; index < batch.length; index += 1) {
        if (existence[index]) continue;
        const object = batch[index]!;
        issues.push({
          runId: run.id,
          tenantId: run.tenantId,
          issueKey: this.issueKey('DATABASE_OBJECT_MISSING', object.id),
          issueType: 'DATABASE_OBJECT_MISSING',
          storageObjectId: object.id,
          expectedSizeBytes: object.sizeBytes,
          databaseCreatedAt: object.createdAt,
        });
      }
    }
    const hasMore = objects.length === databaseBatchSize;
    await this.checkpoint(job, run, expectation, {
      phase: hasMore ? 'DATABASE_SCAN' : 'STORAGE_SCAN',
      databaseCursor: hasMore ? objects.at(-1)!.id : null,
      storageCursor: null,
      databaseObjects: objects.length,
      storageObjects: 0,
      missingObjects: issues.length,
      unknownObjects: 0,
      issues,
    });
  }

  private async processStoragePage(
    job: ClaimedMaintenanceJob,
    run: ReconciliationRunCheckpoint,
    expectation: StepExpectation,
  ): Promise<void> {
    const page = await this.storage.listTenantObjectsPage(
      run.tenantId,
      run.storageCursor,
      storageBatchSize,
    );
    const eligible = page.items.filter((object) => object.lastModified <= run.cutoffAt);
    const knownKeys = await this.knownStorageKeys(
      run.tenantId,
      eligible.map(({ objectKey }) => objectKey),
      run.cutoffAt,
    );
    const issues: Prisma.StorageReconciliationIssueCreateManyInput[] = [];
    for (const object of eligible) {
      if (knownKeys.has(object.objectKey)) continue;
      const fingerprint = this.issueKey('STORAGE_OBJECT_UNKNOWN', object.objectKey);
      issues.push({
        runId: run.id,
        tenantId: run.tenantId,
        issueKey: fingerprint,
        issueType: 'STORAGE_OBJECT_UNKNOWN',
        objectFingerprint: fingerprint,
        observedSizeBytes: object.sizeBytes,
        lastModifiedAt: object.lastModified,
      });
    }
    await this.checkpoint(job, run, expectation, {
      phase: page.nextCursor === null ? 'FINALIZING' : 'STORAGE_SCAN',
      databaseCursor: null,
      storageCursor: page.nextCursor,
      databaseObjects: 0,
      storageObjects: eligible.length,
      missingObjects: 0,
      unknownObjects: issues.length,
      issues,
    });
  }

  private async knownStorageKeys(
    tenantId: string,
    objectKeys: string[],
    cutoffAt: Date,
  ): Promise<Set<string>> {
    if (objectKeys.length === 0) return new Set();
    const bucket = this.storage.bucketName();
    const [registeredObjects, uploadSessions, deletionJobs] = await Promise.all([
      this.prisma.storageObject.findMany({
        where: { bucket, objectKey: { in: objectKeys }, createdAt: { lte: cutoffAt } },
        select: { objectKey: true },
      }),
      this.prisma.uploadSession.findMany({
        where: {
          space: { tenantId },
          status: { in: [...knownUploadStatuses] },
          objectKey: { in: objectKeys },
          createdAt: { lte: cutoffAt },
        },
        select: { objectKey: true },
      }),
      this.prisma.maintenanceJob.findMany({
        where: {
          tenantId,
          jobType: 'DELETE_STORAGE_OBJECT',
          status: { in: [...pendingDeletionStatuses] },
          createdAt: { lte: cutoffAt },
          AND: [{ payload: { path: ['bucket'], equals: bucket } }],
          OR: objectKeys.map((objectKey) => ({
            payload: { path: ['objectKey'], equals: objectKey },
          })),
        },
        select: { payload: true },
      }),
    ]);
    return new Set([
      ...registeredObjects.map(({ objectKey }) => objectKey),
      ...uploadSessions.map(({ objectKey }) => objectKey),
      ...deletionJobs.flatMap(({ payload }) => {
        const objectKey = this.deletionObjectKey(payload, bucket);
        return objectKey === null ? [] : [objectKey];
      }),
    ]);
  }

  private async checkpoint(
    job: ClaimedMaintenanceJob,
    run: ReconciliationRunCheckpoint,
    expectation: StepExpectation,
    change: CheckpointChange,
  ): Promise<void> {
    await this.queue.renew(job);
    const nextVersion = expectation.checkpointVersion + 1;
    await this.prisma.$transaction(async (database) => {
      await this.queue.assertActiveLease(database, job);
      const advanced = await database.storageReconciliationRun.updateMany({
        where: {
          id: run.id,
          tenantId: run.tenantId,
          status: 'RUNNING',
          phase: expectation.phase,
          checkpointVersion: expectation.checkpointVersion,
        },
        data: {
          phase: change.phase,
          checkpointVersion: { increment: 1 },
          databaseCursor: change.databaseCursor,
          storageCursor: change.storageCursor,
          databaseObjects: { increment: change.databaseObjects },
          storageObjects: { increment: change.storageObjects },
          missingObjects: { increment: change.missingObjects },
          unknownObjects: { increment: change.unknownObjects },
          lastCheckpointAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      if (advanced.count === 0) return;
      if (change.issues.length > 0) {
        await database.storageReconciliationIssue.createMany({
          data: change.issues,
          skipDuplicates: true,
        });
      }
      await database.maintenanceJob.createMany({
        data: [
          {
            tenantId: run.tenantId,
            jobType: 'RECONCILE_STORAGE_STEP',
            idempotencyKey: this.stepIdempotencyKey(run.id, nextVersion),
            targetId: run.id,
            payload: { phase: change.phase, checkpointVersion: nextVersion },
            maxAttempts: job.maxAttempts,
          },
        ],
        skipDuplicates: true,
      });
    });
  }

  private async finalize(
    job: ClaimedMaintenanceJob,
    run: ReconciliationRunCheckpoint,
    expectation: StepExpectation,
  ): Promise<void> {
    await this.queue.renew(job);
    await this.prisma.$transaction(async (database) => {
      await this.queue.assertActiveLease(database, job);
      const completedAt = new Date();
      const completed = await database.storageReconciliationRun.updateMany({
        where: {
          id: run.id,
          tenantId: run.tenantId,
          status: 'RUNNING',
          phase: expectation.phase,
          checkpointVersion: expectation.checkpointVersion,
        },
        data: {
          status: 'SUCCEEDED',
          phase: 'COMPLETE',
          checkpointVersion: { increment: 1 },
          databaseCursor: null,
          storageCursor: null,
          lastCheckpointAt: completedAt,
          completedAt,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (completed.count === 0) return;
      await database.auditEvent.create({
        data: {
          tenantId: run.tenantId,
          actorUserId: run.requestedById,
          action: 'storage.reconciliation.completed',
          resourceType: 'STORAGE_RECONCILIATION_RUN',
          resourceId: run.id,
          result: 'SUCCEEDED',
          details: {
            databaseObjects: run.databaseObjects,
            storageObjects: run.storageObjects,
            missingObjects: run.missingObjects,
            unknownObjects: run.unknownObjects,
          },
        },
      });
    });
  }

  private expectation(payload: Prisma.JsonValue): StepExpectation {
    const expectation = this.tryExpectation(payload);
    if (expectation === null || expectation.phase === 'COMPLETE') {
      throw new Error('Storage reconciliation job payload is invalid');
    }
    return expectation;
  }

  private tryExpectation(payload: Prisma.JsonValue): StepExpectation | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const phase = payload['phase'];
    const checkpointVersion = payload['checkpointVersion'];
    if (
      typeof phase !== 'string' ||
      !['DATABASE_SCAN', 'STORAGE_SCAN', 'FINALIZING', 'COMPLETE'].includes(phase) ||
      typeof checkpointVersion !== 'number' ||
      !Number.isInteger(checkpointVersion) ||
      checkpointVersion < 0
    ) {
      return null;
    }
    return { phase: phase as ReconciliationPhase, checkpointVersion };
  }

  private deletionObjectKey(payload: Prisma.JsonValue, expectedBucket: string): string | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    return payload['bucket'] === expectedBucket && typeof payload['objectKey'] === 'string'
      ? payload['objectKey']
      : null;
  }

  private safeFailure(error: unknown): { code: string; message: string } {
    if (error instanceof StorageReconciliationStepError) {
      return { code: error.code, message: error.message };
    }
    return {
      code: 'RECONCILIATION_STEP_FAILED',
      message: 'Storage reconciliation step failed',
    };
  }

  private issueKey(issueType: string, value: string): string {
    return createHash('sha256').update(issueType).update('\0').update(value).digest('hex');
  }

  private tenantPrefix(tenantId: string): string {
    return `tenants/${tenantId}/`;
  }

  private stepIdempotencyKey(runId: string, checkpointVersion: number): string {
    return `reconciliation:${runId}:step:${checkpointVersion}`;
  }
}
