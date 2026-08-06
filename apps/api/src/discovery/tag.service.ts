import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';
import { Prisma } from '@dam/database';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { AssignAssetTagsDto, CreateTagDto, UpdateTagDto } from './dto/discovery.dto.js';

@Injectable()
export class TagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(actor: AuthenticatedUser, spaceId: string) {
    await this.assertSpaceEntry(actor, spaceId);
    return this.prisma.tag.findMany({
      where: { spaceId },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true, createdAt: true },
    });
  }

  async create(
    actor: AuthenticatedUser,
    spaceId: string,
    input: CreateTagDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'space.manage',
      { type: 'SPACE', id: spaceId },
      metadata,
    );
    const normalized = this.normalize(input.name);
    try {
      return await this.prisma.$transaction(async (database) => {
        const tag = await database.tag.create({
          data: {
            spaceId,
            name: normalized.name,
            normalizedName: normalized.normalizedName,
            color: input.color ?? null,
          },
          select: { id: true, name: true, color: true, createdAt: true },
        });
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'tag.create',
            resourceType: 'TAG',
            resourceId: tag.id,
            result: 'SUCCEEDED',
            ...this.auditMetadata(metadata),
            afterData: { spaceId, name: tag.name, color: tag.color },
          },
        });
        return tag;
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async update(
    actor: AuthenticatedUser,
    spaceId: string,
    tagId: string,
    input: UpdateTagDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'space.manage',
      { type: 'SPACE', id: spaceId },
      metadata,
    );
    const before = await this.tag(actor.tenantId, spaceId, tagId);
    if (input.name === undefined && input.color === undefined) {
      return before;
    }
    const normalized = input.name === undefined ? null : this.normalize(input.name);
    try {
      return await this.prisma.$transaction(async (database) => {
        const tag = await database.tag.update({
          where: { id: tagId },
          data: {
            ...(normalized === null
              ? {}
              : { name: normalized.name, normalizedName: normalized.normalizedName }),
            ...(input.color === undefined ? {} : { color: input.color }),
          },
          select: { id: true, name: true, color: true, createdAt: true },
        });
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'tag.update',
            resourceType: 'TAG',
            resourceId: tag.id,
            result: 'SUCCEEDED',
            ...this.auditMetadata(metadata),
            beforeData: { name: before.name, color: before.color },
            afterData: { name: tag.name, color: tag.color },
          },
        });
        return tag;
      });
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async remove(
    actor: AuthenticatedUser,
    spaceId: string,
    tagId: string,
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    await this.authorization.assert(
      actor,
      'space.manage',
      { type: 'SPACE', id: spaceId },
      metadata,
    );
    const before = await this.tag(actor.tenantId, spaceId, tagId);
    await this.prisma.$transaction(async (database) => {
      await database.tag.delete({ where: { id: tagId } });
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'tag.delete',
          resourceType: 'TAG',
          resourceId: tagId,
          result: 'SUCCEEDED',
          ...this.auditMetadata(metadata),
          beforeData: { spaceId, name: before.name, color: before.color },
        },
      });
    });
  }

  async assetTags(actor: AuthenticatedUser, assetId: string) {
    const asset = await this.asset(actor.tenantId, assetId);
    await this.authorization.assert(actor, 'node.view', { type: 'NODE', id: asset.nodeId });
    return this.prisma.tag.findMany({
      where: { assets: { some: { assetId } } },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true },
    });
  }

  async assign(
    actor: AuthenticatedUser,
    assetId: string,
    input: AssignAssetTagsDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const asset = await this.asset(actor.tenantId, assetId);
    await this.authorization.assert(
      actor,
      'node.update',
      { type: 'NODE', id: asset.nodeId },
      metadata,
    );
    const tags = await this.prisma.tag.findMany({
      where: { id: { in: input.tagIds }, spaceId: asset.spaceId },
      select: { id: true },
    });
    if (tags.length !== input.tagIds.length) {
      throw this.notFound();
    }
    const before = await this.prisma.assetTag.findMany({
      where: { assetId },
      select: { tagId: true },
    });
    await this.prisma.$transaction(async (database) => {
      await database.assetTag.deleteMany({ where: { assetId } });
      await database.assetTag.createMany({
        data: input.tagIds.map((tagId) => ({ assetId, tagId })),
        skipDuplicates: true,
      });
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'asset.tags.update',
          resourceType: 'NODE',
          resourceId: asset.nodeId,
          result: 'SUCCEEDED',
          ...this.auditMetadata(metadata),
          beforeData: { tagIds: before.map(({ tagId }) => tagId) },
          afterData: { tagIds: input.tagIds },
        },
      });
    });
    return this.assetTags(actor, assetId);
  }

  private async assertSpaceEntry(actor: AuthenticatedUser, spaceId: string): Promise<void> {
    if (!(await this.authorization.canEnterSpace(actor, spaceId))) {
      throw this.notFound();
    }
  }

  private async tag(tenantId: string, spaceId: string, tagId: string) {
    const tag = await this.prisma.tag.findFirst({
      where: { id: tagId, spaceId, space: { tenantId } },
      select: { id: true, name: true, color: true, createdAt: true },
    });
    if (tag === null) {
      throw this.notFound();
    }
    return tag;
  }

  private async asset(tenantId: string, assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        node: { status: { in: ['ACTIVE', 'QUARANTINED'] }, space: { tenantId } },
      },
      select: { id: true, nodeId: true, node: { select: { spaceId: true } } },
    });
    if (asset === null) {
      throw this.notFound();
    }
    return { id: asset.id, nodeId: asset.nodeId, spaceId: asset.node.spaceId };
  }

  private normalize(value: string): { name: string; normalizedName: string } {
    const name = value.normalize('NFKC').trim();
    if (name.length === 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', '标签名称不能为空');
    }
    return { name, normalizedName: name.toLocaleLowerCase('zh-CN') };
  }

  private auditMetadata(metadata: AuthorizationRequestMetadata) {
    return {
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
    };
  }

  private rethrowConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ApiException(HttpStatus.CONFLICT, 'VERSION_CONFLICT', '当前空间已存在同名标签');
    }
    throw error;
  }

  private notFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '资源不存在或你无权查看');
  }
}
