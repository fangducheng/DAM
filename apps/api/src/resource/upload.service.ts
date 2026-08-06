import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthenticatedUser } from '@dam/contracts';
import { Prisma } from '@dam/database';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { scheduleUploadExpiration } from '../maintenance/maintenance-scheduling.js';
import type { CreateUploadSessionDto, RecordUploadPartDto } from './dto/resource.dto.js';
import { normalizeResourceName } from './resource-name.js';

const minimumPartSize = 8 * 1024 * 1024;
const partSizeUnit = 1024 * 1024;
const maximumPartCount = 10_000;
const maximumObjectSize = 5n * 1024n * 1024n * 1024n * 1024n;
const activeUploadStatuses = ['CREATED', 'UPLOADING'] as const;

interface UploadShape {
  id: string;
  spaceId: string;
  targetNodeId: string | null;
  assetId: string | null;
  initiatedById: string;
  uploadId: string | null;
  objectKey: string;
  fileName: string;
  sizeBytes: bigint;
  mimeType: string;
  checksumSha256: string | null;
  status: 'CREATED' | 'UPLOADING' | 'COMPLETED' | 'ABORTED' | 'EXPIRED';
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  parts: Array<{ partNumber: number; etag: string; sizeBytes: bigint; recordedAt: Date }>;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly sessionTtlHours: number;
  private readonly urlTtlSeconds: number;
  private readonly processingMode: 'deferred' | 'local-bypass';

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly storage: ObjectStorageService,
    config: ConfigService,
  ) {
    this.sessionTtlHours = config.getOrThrow<number>('ASSET_UPLOAD_SESSION_TTL_HOURS');
    this.urlTtlSeconds = config.getOrThrow<number>('ASSET_UPLOAD_URL_TTL_SECONDS');
    this.processingMode = config.getOrThrow<'deferred' | 'local-bypass'>('ASSET_PROCESSING_MODE');
  }

  async create(
    actor: AuthenticatedUser,
    spaceId: string,
    input: CreateUploadSessionDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const sizeBytes = this.parseSize(input.sizeBytes);
    const normalized = normalizeResourceName(input.fileName, 'fileName');
    const target = await this.resolveTarget(actor, spaceId, input);
    await this.assertQuota(spaceId, actor.tenantId, sizeBytes);
    if (input.assetId === undefined) {
      await this.assertAvailableName(
        spaceId,
        target.folderId,
        normalized.normalizedName,
        input.fileName,
      );
    }

    const objectKey = `tenants/${actor.tenantId}/spaces/${spaceId}/objects/${randomUUID()}`;
    const uploadId = await this.storage.initiateMultipart(objectKey, input.mimeType);
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 60 * 60 * 1000);
    try {
      const session = await this.prisma.$transaction(
        async (database) => {
          await this.lockSpace(database, spaceId, actor.tenantId);
          await this.assertQuota(spaceId, actor.tenantId, sizeBytes, database);
          const created = await database.uploadSession.create({
            data: {
              spaceId,
              targetNodeId: target.folderId,
              assetId: target.assetId,
              initiatedById: actor.userId,
              uploadId,
              objectKey,
              fileName: normalized.name,
              sizeBytes,
              mimeType: input.mimeType.toLowerCase(),
              checksumSha256: input.checksumSha256?.toLowerCase() ?? null,
              expiresAt,
            },
            include: { parts: { orderBy: { partNumber: 'asc' } } },
          });
          await database.auditEvent.create({
            data: {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: 'asset.upload.create',
              resourceType: target.assetId === null ? 'SPACE' : 'ASSET',
              resourceId: target.assetId ?? spaceId,
              result: 'SUCCEEDED',
              ...this.auditMetadata(metadata),
              details: {
                uploadSessionId: created.id,
                fileName: created.fileName,
                sizeBytes: created.sizeBytes.toString(),
              },
            },
          });
          await scheduleUploadExpiration(database, {
            sessionId: created.id,
            tenantId: actor.tenantId,
            spaceId,
            expiresAt,
          });
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return this.serializeSession(session);
    } catch (error) {
      await this.ignoreStorageFailure(() => this.storage.abortMultipart(objectKey, uploadId));
      this.rethrowWriteConflict(error);
    }
  }

  async get(actor: AuthenticatedUser, sessionId: string) {
    const session = await this.session(actor, sessionId);
    if (this.isExpired(session)) {
      await this.expire(session);
      throw this.conflict('上传会话已过期，请重新开始上传');
    }
    return this.serializeSession(session);
  }

  async partUrl(actor: AuthenticatedUser, sessionId: string, partNumber: number) {
    const session = await this.activeSession(actor, sessionId);
    const { partCount } = this.multipartShape(session.sizeBytes);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        '分片编号超出上传会话范围',
      );
    }
    const remainingSeconds = Math.max(
      1,
      Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
    );
    const expiresInSeconds = Math.min(this.urlTtlSeconds, remainingSeconds);
    const url = await this.storage.presignMultipartPart(
      session.objectKey,
      session.uploadId!,
      partNumber,
      expiresInSeconds,
    );
    return {
      partNumber,
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  async recordPart(
    actor: AuthenticatedUser,
    sessionId: string,
    partNumber: number,
    input: RecordUploadPartDto,
  ) {
    const session = await this.activeSession(actor, sessionId);
    const shape = this.multipartShape(session.sizeBytes);
    if (partNumber < 1 || partNumber > shape.partCount) {
      throw this.conflict('分片编号超出上传会话范围');
    }
    const expectedSize = this.expectedPartSize(session.sizeBytes, shape.partSize, partNumber);
    const actualSize = BigInt(input.sizeBytes);
    if (actualSize !== expectedSize) {
      throw this.conflict('分片大小与上传会话不一致');
    }
    const part = await this.prisma.$transaction(async (database) => {
      const recorded = await database.uploadPart.upsert({
        where: { uploadSessionId_partNumber: { uploadSessionId: sessionId, partNumber } },
        update: { etag: this.cleanEtag(input.etag), sizeBytes: actualSize, recordedAt: new Date() },
        create: {
          uploadSessionId: sessionId,
          partNumber,
          etag: this.cleanEtag(input.etag),
          sizeBytes: actualSize,
        },
      });
      await database.uploadSession.updateMany({
        where: { id: sessionId, status: { in: [...activeUploadStatuses] } },
        data: { status: 'UPLOADING' },
      });
      return recorded;
    });
    return { ...part, sizeBytes: part.sizeBytes.toString() };
  }

  async complete(
    actor: AuthenticatedUser,
    sessionId: string,
    metadata: AuthorizationRequestMetadata,
  ) {
    const existing = await this.session(actor, sessionId);
    if (existing.status === 'COMPLETED' && existing.assetId !== null) {
      return this.completedResult(existing.assetId);
    }
    const session = await this.activeSession(actor, sessionId);
    const shape = this.multipartShape(session.sizeBytes);
    this.assertCompleteParts(session, shape.partCount, shape.partSize);

    let committed = false;
    try {
      try {
        await this.storage.completeMultipart(
          session.objectKey,
          session.uploadId!,
          session.parts.map((part) => ({ part: part.partNumber, etag: part.etag })),
        );
      } catch (error) {
        try {
          await this.storage.objectSize(session.objectKey);
        } catch {
          throw error;
        }
      }
      const actualSize = await this.storage.objectSize(session.objectKey);
      if (actualSize !== session.sizeBytes) {
        throw this.conflict('上传后的对象大小与声明不一致');
      }
      const checksumSha256 = await this.storage.sha256(session.objectKey);
      if (
        session.checksumSha256 !== null &&
        checksumSha256.toLowerCase() !== session.checksumSha256.toLowerCase()
      ) {
        throw this.conflict('文件完整性校验失败，请重新上传');
      }

      const result = await this.commitAsset(actor, session, checksumSha256, metadata);
      committed = true;
      return result;
    } catch (error) {
      if (!committed) {
        await this.ignoreStorageFailure(() => this.storage.removeObject(session.objectKey));
        await this.prisma.uploadSession.updateMany({
          where: { id: session.id, status: { in: [...activeUploadStatuses] } },
          data: { status: 'ABORTED' },
        });
      }
      this.rethrowWriteConflict(error);
    }
  }

  async abort(actor: AuthenticatedUser, sessionId: string): Promise<void> {
    const session = await this.activeSession(actor, sessionId);
    await this.ignoreStorageFailure(() =>
      this.storage.abortMultipart(session.objectKey, session.uploadId!),
    );
    await this.prisma.uploadSession.updateMany({
      where: { id: session.id, status: { in: [...activeUploadStatuses] } },
      data: { status: 'ABORTED' },
    });
  }

  private async commitAsset(
    actor: AuthenticatedUser,
    session: UploadShape,
    checksumSha256: string,
    metadata: AuthorizationRequestMetadata,
  ) {
    return this.prisma.$transaction(
      async (database) => {
        await this.lockSpace(database, session.spaceId, actor.tenantId);
        const space = await database.space.findFirst({
          where: { id: session.spaceId, tenantId: actor.tenantId, status: 'ACTIVE' },
          select: { usedBytes: true, quotaBytes: true },
        });
        if (
          space === null ||
          (space.quotaBytes !== 0n && space.usedBytes + session.sizeBytes > space.quotaBytes)
        ) {
          throw this.conflict('空间剩余配额不足，无法完成上传');
        }
        const state =
          this.processingMode === 'local-bypass'
            ? ({ node: 'ACTIVE', version: 'AVAILABLE', scan: 'SKIPPED' } as const)
            : ({ node: 'QUARANTINED', version: 'QUARANTINED', scan: 'PENDING' } as const);
        const storageObject = await database.storageObject.create({
          data: {
            bucket: this.storage.bucketName(),
            objectKey: session.objectKey,
            checksumSha256,
            sizeBytes: session.sizeBytes,
          },
        });

        let assetId = session.assetId;
        let nodeId: string;
        let versionNumber: number;
        if (assetId === null) {
          if (session.targetNodeId === null) {
            throw this.conflict('上传会话缺少目标目录');
          }
          const target = await database.resourceNode.findFirst({
            where: {
              id: session.targetNodeId,
              spaceId: session.spaceId,
              nodeType: 'FOLDER',
              status: 'ACTIVE',
            },
            select: { id: true },
          });
          if (target === null) {
            throw this.conflict('目标目录已不可用，请重新上传');
          }
          const normalized = normalizeResourceName(session.fileName, 'fileName');
          const node = await database.resourceNode.create({
            data: {
              spaceId: session.spaceId,
              parentId: target.id,
              nodeType: 'ASSET',
              ...normalized,
              status: state.node,
              createdById: actor.userId,
            },
          });
          const ancestors = await database.resourceClosure.findMany({
            where: { descendantId: target.id },
            select: { ancestorId: true, depth: true },
          });
          await database.resourceClosure.createMany({
            data: [
              { ancestorId: node.id, descendantId: node.id, depth: 0 },
              ...ancestors.map(({ ancestorId, depth }) => ({
                ancestorId,
                descendantId: node.id,
                depth: depth + 1,
              })),
            ],
          });
          const asset = await database.asset.create({
            data: {
              nodeId: node.id,
              originalFileName: session.fileName,
              mimeType: session.mimeType,
            },
          });
          assetId = asset.id;
          nodeId = node.id;
          versionNumber = 1;
        } else {
          const asset = await database.asset.findFirst({
            where: {
              id: assetId,
              node: {
                spaceId: session.spaceId,
                status: { in: ['ACTIVE', 'QUARANTINED'] },
                space: { tenantId: actor.tenantId },
              },
            },
            select: {
              nodeId: true,
              versions: {
                orderBy: { versionNumber: 'desc' },
                take: 1,
                select: { versionNumber: true },
              },
            },
          });
          if (asset === null) {
            throw this.conflict('资产已不可用，无法添加新版本');
          }
          nodeId = asset.nodeId;
          versionNumber = (asset.versions[0]?.versionNumber ?? 0) + 1;
        }

        const version = await database.assetVersion.create({
          data: {
            assetId,
            versionNumber,
            storageObjectId: storageObject.id,
            status: state.version,
            scanStatus: state.scan,
            checksumSha256,
            sizeBytes: session.sizeBytes,
            mimeType: session.mimeType,
            createdById: actor.userId,
          },
        });
        if (this.processingMode === 'deferred') {
          await database.processingJob.create({
            data: {
              assetVersionId: version.id,
              jobType: 'MALWARE_SCAN',
            },
          });
        }
        await database.asset.update({
          where: { id: assetId },
          data: {
            currentVersionId: version.id,
            originalFileName: session.fileName,
            mimeType: session.mimeType,
          },
        });
        await database.resourceNode.update({
          where: { id: nodeId },
          data: { status: state.node, lockVersion: { increment: 1 } },
        });
        await database.space.update({
          where: { id: session.spaceId },
          data: { usedBytes: { increment: session.sizeBytes } },
        });
        const completed = await database.uploadSession.updateMany({
          where: { id: session.id, status: { in: [...activeUploadStatuses] } },
          data: { status: 'COMPLETED', assetId },
        });
        if (completed.count !== 1) {
          throw this.conflict('上传会话状态已变化，请刷新后重试');
        }
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: versionNumber === 1 ? 'asset.create' : 'asset.version.create',
            resourceType: 'NODE',
            resourceId: nodeId,
            result: 'SUCCEEDED',
            ...this.auditMetadata(metadata),
            afterData: {
              assetId,
              versionId: version.id,
              versionNumber,
              fileName: session.fileName,
              sizeBytes: session.sizeBytes.toString(),
              checksumSha256,
              processingMode: this.processingMode,
            },
          },
        });
        return {
          assetId,
          nodeId,
          versionId: version.id,
          versionNumber,
          status: version.status,
          scanStatus: version.scanStatus,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async completedResult(assetId: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        nodeId: true,
        currentVersion: {
          select: { id: true, versionNumber: true, status: true, scanStatus: true },
        },
      },
    });
    if (asset === null || asset.currentVersion === null) {
      throw this.conflict('已完成的上传缺少资产版本，请联系管理员');
    }
    return {
      assetId: asset.id,
      nodeId: asset.nodeId,
      versionId: asset.currentVersion.id,
      versionNumber: asset.currentVersion.versionNumber,
      status: asset.currentVersion.status,
      scanStatus: asset.currentVersion.scanStatus,
    };
  }

  private async resolveTarget(
    actor: AuthenticatedUser,
    spaceId: string,
    input: CreateUploadSessionDto,
  ): Promise<{ folderId: string; assetId: string | null }> {
    if (!(await this.authorization.canEnterSpace(actor, spaceId))) {
      throw this.notFound();
    }
    if (input.assetId !== undefined) {
      const asset = await this.prisma.asset.findFirst({
        where: {
          id: input.assetId,
          node: {
            spaceId,
            status: { in: ['ACTIVE', 'QUARANTINED'] },
            space: { tenantId: actor.tenantId },
          },
        },
        select: { id: true, node: { select: { id: true, parentId: true } } },
      });
      if (asset === null || asset.node.parentId === null) {
        throw this.notFound();
      }
      await this.authorization.assert(actor, 'node.update', {
        type: 'NODE',
        id: asset.node.id,
      });
      if (input.targetFolderId !== undefined && input.targetFolderId !== asset.node.parentId) {
        throw this.conflict('添加资产版本时不能同时更改目标目录');
      }
      return { folderId: asset.node.parentId, assetId: asset.id };
    }
    const folder = await this.prisma.resourceNode.findFirst({
      where: {
        spaceId,
        ...(input.targetFolderId === undefined
          ? { isRoot: true }
          : { id: input.targetFolderId, nodeType: 'FOLDER' }),
        status: 'ACTIVE',
        space: { tenantId: actor.tenantId },
      },
      select: { id: true },
    });
    if (folder === null) {
      throw this.notFound();
    }
    await this.authorization.assert(actor, 'node.create', { type: 'NODE', id: folder.id });
    return { folderId: folder.id, assetId: null };
  }

  private async assertAvailableName(
    spaceId: string,
    folderId: string,
    normalizedName: string,
    fileName: string,
  ): Promise<void> {
    const [node, upload] = await Promise.all([
      this.prisma.resourceNode.findFirst({
        where: {
          spaceId,
          parentId: folderId,
          normalizedName,
          status: { in: ['ACTIVE', 'QUARANTINED'] },
        },
        select: { id: true },
      }),
      this.prisma.uploadSession.findFirst({
        where: {
          spaceId,
          targetNodeId: folderId,
          fileName: { equals: fileName, mode: 'insensitive' },
          status: { in: [...activeUploadStatuses] },
          expiresAt: { gt: new Date() },
          assetId: null,
        },
        select: { id: true },
      }),
    ]);
    if (node !== null || upload !== null) {
      throw this.conflict('当前目录中已存在同名资源或同名上传任务');
    }
  }

  private async assertQuota(
    spaceId: string,
    tenantId: string,
    requestedBytes: bigint,
    database: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const [space, reserved] = await Promise.all([
      database.space.findFirst({
        where: { id: spaceId, tenantId, status: 'ACTIVE' },
        select: { quotaBytes: true, usedBytes: true },
      }),
      database.uploadSession.aggregate({
        where: {
          spaceId,
          status: { in: [...activeUploadStatuses] },
          expiresAt: { gt: new Date() },
        },
        _sum: { sizeBytes: true },
      }),
    ]);
    if (space === null) {
      throw this.notFound();
    }
    const reservedBytes = reserved._sum.sizeBytes ?? 0n;
    if (
      space.quotaBytes !== 0n &&
      space.usedBytes + reservedBytes + requestedBytes > space.quotaBytes
    ) {
      throw this.conflict('空间剩余配额不足');
    }
  }

  private async lockSpace(
    database: Prisma.TransactionClient,
    spaceId: string,
    tenantId: string,
  ): Promise<void> {
    const rows = await database.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "spaces"
      WHERE "id" = ${spaceId}::uuid AND "tenant_id" = ${tenantId}::uuid
      FOR UPDATE
    `;
    if (rows.length !== 1) {
      throw this.notFound();
    }
  }

  private async session(actor: AuthenticatedUser, sessionId: string): Promise<UploadShape> {
    const session = await this.prisma.uploadSession.findFirst({
      where: {
        id: sessionId,
        initiatedById: actor.userId,
        space: { tenantId: actor.tenantId },
      },
      include: { parts: { orderBy: { partNumber: 'asc' } } },
    });
    if (session === null) {
      throw this.notFound();
    }
    return session;
  }

  private async activeSession(actor: AuthenticatedUser, sessionId: string): Promise<UploadShape> {
    const session = await this.session(actor, sessionId);
    if (this.isExpired(session)) {
      await this.expire(session);
      throw this.conflict('上传会话已过期，请重新开始上传');
    }
    if (!activeUploadStatuses.includes(session.status as (typeof activeUploadStatuses)[number])) {
      throw this.conflict('上传会话已结束，不能继续修改');
    }
    if (session.uploadId === null) {
      throw this.conflict('上传会话缺少对象存储标识');
    }
    return session;
  }

  private async expire(session: UploadShape): Promise<void> {
    if (session.uploadId !== null) {
      await this.ignoreStorageFailure(() =>
        this.storage.abortMultipart(session.objectKey, session.uploadId!),
      );
    }
    await this.prisma.uploadSession.updateMany({
      where: { id: session.id, status: { in: [...activeUploadStatuses] } },
      data: { status: 'EXPIRED' },
    });
  }

  private assertCompleteParts(session: UploadShape, partCount: number, partSize: number): void {
    if (session.parts.length !== partCount) {
      throw this.conflict(
        `上传尚未完成：需要 ${partCount} 个分片，已记录 ${session.parts.length} 个`,
      );
    }
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const part = session.parts[partNumber - 1];
      if (
        part?.partNumber !== partNumber ||
        part.sizeBytes !== this.expectedPartSize(session.sizeBytes, partSize, partNumber)
      ) {
        throw this.conflict(`第 ${partNumber} 个分片记录无效`);
      }
    }
  }

  private multipartShape(sizeBytes: bigint): { partSize: number; partCount: number } {
    const requiredPartSize = Number(
      (sizeBytes + BigInt(maximumPartCount) - 1n) / BigInt(maximumPartCount),
    );
    const partSize = Math.max(
      minimumPartSize,
      Math.ceil(requiredPartSize / partSizeUnit) * partSizeUnit,
    );
    const partCount = Number((sizeBytes + BigInt(partSize) - 1n) / BigInt(partSize));
    return { partSize, partCount };
  }

  private expectedPartSize(sizeBytes: bigint, partSize: number, partNumber: number): bigint {
    const consumed = BigInt(partSize) * BigInt(partNumber - 1);
    const remaining = sizeBytes - consumed;
    return remaining > BigInt(partSize) ? BigInt(partSize) : remaining;
  }

  private parseSize(value: string): bigint {
    const size = BigInt(value);
    if (size < 1n || size > maximumObjectSize) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        '文件大小必须大于 0 且不能超过 5 TiB',
        [{ field: 'sizeBytes', code: 'assetSize', message: '文件大小超出支持范围' }],
      );
    }
    return size;
  }

  private serializeSession(session: UploadShape) {
    const shape = this.multipartShape(session.sizeBytes);
    return {
      ...session,
      sizeBytes: session.sizeBytes.toString(),
      partSize: shape.partSize,
      partCount: shape.partCount,
      parts: session.parts.map((part) => ({ ...part, sizeBytes: part.sizeBytes.toString() })),
    };
  }

  private cleanEtag(value: string): string {
    return value.replace(/^"|"$/g, '').toLowerCase();
  }

  private isExpired(session: UploadShape): boolean {
    return (
      activeUploadStatuses.includes(session.status as (typeof activeUploadStatuses)[number]) &&
      session.expiresAt <= new Date()
    );
  }

  private async ignoreStorageFailure(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.logger.warn(
        `Object storage cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private auditMetadata(metadata: AuthorizationRequestMetadata) {
    return {
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
    };
  }

  private conflict(message: string): ApiException {
    return new ApiException(HttpStatus.CONFLICT, 'VERSION_CONFLICT', message);
  }

  private rethrowWriteConflict(error: unknown): never {
    if (error instanceof ApiException) {
      throw error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw this.conflict('目标目录中已存在同名资源');
      }
      if (error.code === 'P2034') {
        throw this.conflict('空间数据已被其他用户更新，请刷新后重试');
      }
    }
    throw error;
  }

  private notFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '资源不存在或你无权查看');
  }
}
