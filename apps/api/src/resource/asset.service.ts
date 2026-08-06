import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';

@Injectable()
export class AssetService {
  private readonly readUrlTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly storage: ObjectStorageService,
    config: ConfigService,
  ) {
    this.readUrlTtlSeconds = config.getOrThrow<number>('ASSET_READ_URL_TTL_SECONDS');
  }

  async versions(actor: AuthenticatedUser, assetId: string) {
    const asset = await this.asset(actor.tenantId, assetId);
    await this.authorization.assert(actor, 'node.view', { type: 'NODE', id: asset.nodeId });
    const versions = await this.prisma.assetVersion.findMany({
      where: { assetId },
      orderBy: { versionNumber: 'desc' },
      select: {
        id: true,
        versionNumber: true,
        status: true,
        scanStatus: true,
        checksumSha256: true,
        sizeBytes: true,
        mimeType: true,
        createdAt: true,
        createdBy: { select: { id: true, displayName: true } },
        extraction: { select: { parserVersion: true, extractedAt: true } },
        renditions: {
          orderBy: [{ type: 'asc' as const }, { variant: 'asc' as const }],
          select: {
            id: true,
            type: true,
            variant: true,
            width: true,
            height: true,
            durationMs: true,
            status: true,
          },
        },
        processingJobs: {
          orderBy: { createdAt: 'asc' as const },
          select: {
            id: true,
            jobType: true,
            status: true,
            attempts: true,
            maxAttempts: true,
            errorMessage: true,
            updatedAt: true,
          },
        },
      },
    });
    return {
      currentVersionId: asset.currentVersionId,
      items: versions.map((version) => ({ ...version, sizeBytes: version.sizeBytes.toString() })),
    };
  }

  async setCurrentVersion(
    actor: AuthenticatedUser,
    assetId: string,
    versionId: string,
    metadata: AuthorizationRequestMetadata,
  ) {
    const asset = await this.asset(actor.tenantId, assetId);
    await this.authorization.assert(
      actor,
      'node.update',
      { type: 'NODE', id: asset.nodeId },
      metadata,
    );
    const version = await this.prisma.assetVersion.findFirst({
      where: {
        id: versionId,
        assetId,
        status: 'AVAILABLE',
        scanStatus: { in: ['CLEAN', 'SKIPPED'] },
      },
      select: { id: true, versionNumber: true, mimeType: true },
    });
    if (version === null) {
      throw this.conflict('所选版本尚不可用');
    }
    await this.prisma.$transaction(async (database) => {
      await database.asset.update({
        where: { id: assetId },
        data: { currentVersionId: version.id, mimeType: version.mimeType },
      });
      await database.resourceNode.update({
        where: { id: asset.nodeId },
        data: { lockVersion: { increment: 1 } },
      });
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'asset.current-version.update',
          resourceType: 'NODE',
          resourceId: asset.nodeId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          beforeData: { currentVersionId: asset.currentVersionId },
          afterData: { currentVersionId: version.id, versionNumber: version.versionNumber },
        },
      });
    });
    return { currentVersionId: version.id, versionNumber: version.versionNumber };
  }

  async nodeUrl(
    actor: AuthenticatedUser,
    nodeId: string,
    mode: 'preview' | 'download',
    metadata: AuthorizationRequestMetadata = {},
  ) {
    await this.authorization.assert(
      actor,
      mode === 'preview' ? 'node.preview' : 'node.download',
      { type: 'NODE', id: nodeId },
      metadata,
    );
    const asset = await this.prisma.asset.findFirst({
      where: {
        nodeId,
        node: { status: 'ACTIVE', space: { tenantId: actor.tenantId } },
      },
      select: {
        originalFileName: true,
        currentVersion: {
          select: {
            id: true,
            status: true,
            scanStatus: true,
            mimeType: true,
            storageObject: { select: { objectKey: true } },
          },
        },
      },
    });
    if (asset?.currentVersion === null || asset === null) {
      throw this.notFound();
    }
    const issued = await this.issueUrl(asset.currentVersion, asset.originalFileName, mode);
    await this.auditRead(actor, nodeId, asset.currentVersion.id, mode, issued.expiresAt, metadata);
    return issued;
  }

  async versionDownload(
    actor: AuthenticatedUser,
    versionId: string,
    metadata: AuthorizationRequestMetadata,
  ) {
    const version = await this.prisma.assetVersion.findFirst({
      where: { id: versionId, asset: { node: { space: { tenantId: actor.tenantId } } } },
      select: {
        id: true,
        status: true,
        scanStatus: true,
        mimeType: true,
        storageObject: { select: { objectKey: true } },
        asset: { select: { originalFileName: true, nodeId: true } },
      },
    });
    if (version === null) {
      throw this.notFound();
    }
    await this.authorization.assert(
      actor,
      'node.download',
      { type: 'NODE', id: version.asset.nodeId },
      metadata,
    );
    const issued = await this.issueUrl(version, version.asset.originalFileName, 'download');
    await this.auditRead(
      actor,
      version.asset.nodeId,
      version.id,
      'version-download',
      issued.expiresAt,
      metadata,
    );
    return issued;
  }

  private async issueUrl(
    version: {
      id: string;
      status: string;
      scanStatus: string;
      mimeType: string;
      storageObject: { objectKey: string };
    },
    fileName: string,
    mode: 'preview' | 'download',
  ) {
    if (
      version.status !== 'AVAILABLE' ||
      (version.scanStatus !== 'CLEAN' && version.scanStatus !== 'SKIPPED')
    ) {
      throw this.conflict('文件仍在安全处理流程中，暂时不能读取');
    }
    const safeAsciiName = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const disposition = `${mode === 'preview' ? 'inline' : 'attachment'}; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    const url = await this.storage.presignRead(
      version.storageObject.objectKey,
      this.readUrlTtlSeconds,
      {
        'response-content-disposition': disposition,
        'response-content-type': version.mimeType,
      },
    );
    return {
      versionId: version.id,
      url,
      expiresAt: new Date(Date.now() + this.readUrlTtlSeconds * 1000).toISOString(),
    };
  }

  private async asset(tenantId: string, assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        node: { status: { in: ['ACTIVE', 'QUARANTINED'] }, space: { tenantId } },
      },
      select: { id: true, nodeId: true, currentVersionId: true },
    });
    if (asset === null) {
      throw this.notFound();
    }
    return asset;
  }

  private async auditRead(
    actor: AuthenticatedUser,
    nodeId: string,
    versionId: string,
    mode: 'preview' | 'download' | 'version-download',
    expiresAt: string,
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: `asset.${mode}`,
        resourceType: 'NODE',
        resourceId: nodeId,
        result: 'SUCCEEDED',
        ipAddress: metadata.ipAddress ?? null,
        userAgent: metadata.userAgent ?? null,
        requestId: metadata.requestId ?? null,
        details: { versionId, expiresAt },
      },
    });
  }

  private conflict(message: string): ApiException {
    return new ApiException(HttpStatus.CONFLICT, 'VERSION_CONFLICT', message);
  }

  private notFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '资源不存在或你无权查看');
  }
}
