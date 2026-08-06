import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';
import { Prisma } from '@dam/database';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { CreateSpaceDto, SpacePageQueryDto, UpdateSpaceDto } from './dto/space.dto.js';

const maxInt64 = 9_223_372_036_854_775_807n;

@Injectable()
export class SpaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(actor: AuthenticatedUser, query: SpacePageQueryDto) {
    const subject = await this.authorization.subject(actor);
    const canManageTenant = await this.authorization.can(actor, 'tenant.manage', {
      type: 'TENANT',
      id: actor.tenantId,
    });
    const roleBoundSpaceIds = subject.roleBindings
      .filter((binding) => binding.scopeType === 'SPACE' && binding.scopeId !== null)
      .map((binding) => binding.scopeId!);
    const principalFilters = subject.principals.map(({ type, id }) => ({
      principalType: type,
      principalId: id,
    }));
    const spaces = await this.prisma.space.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(canManageTenant
          ? {}
          : {
              status: 'ACTIVE',
              OR: [
                { id: { in: roleBoundSpaceIds } },
                { members: { some: { OR: principalFilters } } },
              ],
            }),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: this.spaceSelection(),
    });
    const page = spaces.slice(0, query.limit).map((space) => this.serialize(space));
    return {
      items: page,
      nextCursor: spaces.length > query.limit && page.length > 0 ? page[page.length - 1]!.id : null,
    };
  }

  async get(actor: AuthenticatedUser, spaceId: string) {
    if (!(await this.authorization.canEnterSpace(actor, spaceId))) {
      throw this.resourceNotFound();
    }
    const space = await this.prisma.space.findFirst({
      where: { id: spaceId, tenantId: actor.tenantId },
      select: this.spaceSelection(),
    });
    if (space === null) {
      throw this.resourceNotFound();
    }
    return this.serialize(space);
  }

  async create(
    actor: AuthenticatedUser,
    input: CreateSpaceDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const ownerOrganizationId = await this.assertOwner(actor, input, metadata);
    const quotaBytes = this.parseQuota(input.quotaBytes);
    const managerRole = await this.prisma.role.findFirst({
      where: { code: 'space_manager', isSystem: true },
      select: { id: true },
    });
    if (managerRole === null) {
      throw new ApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        '空间角色未初始化',
      );
    }

    try {
      const space = await this.prisma.$transaction(async (database) => {
        const created = await database.space.create({
          data: {
            tenantId: actor.tenantId,
            ownerType: input.ownerType,
            ownerOrganizationId,
            code: input.code.trim().toLowerCase(),
            name: input.name.trim(),
            quotaBytes,
            createdById: actor.userId,
          },
          select: this.spaceSelection(),
        });
        await database.spaceMember.create({
          data: {
            spaceId: created.id,
            principalType: 'USER',
            principalId: actor.userId,
            roleId: managerRole.id,
          },
        });
        await this.authorization.bumpVersion(database, actor.tenantId);
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'space.create',
            resourceType: 'SPACE',
            resourceId: created.id,
            result: 'SUCCEEDED',
            ipAddress: metadata.ipAddress ?? null,
            userAgent: metadata.userAgent ?? null,
            requestId: metadata.requestId ?? null,
            afterData: this.auditData(created),
          },
        });
        return created;
      });
      return this.serialize(space);
    } catch (error) {
      this.rethrowConflict(error, '空间代码已存在');
    }
  }

  async update(
    actor: AuthenticatedUser,
    spaceId: string,
    input: UpdateSpaceDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'space.manage',
      { type: 'SPACE', id: spaceId },
      metadata,
    );
    const before = await this.prisma.space.findFirst({
      where: { id: spaceId, tenantId: actor.tenantId },
      select: this.spaceSelection(),
    });
    if (before === null) {
      throw this.resourceNotFound();
    }
    if (Object.keys(input).length === 0) {
      return this.serialize(before);
    }
    const quotaBytes =
      input.quotaBytes === undefined ? undefined : this.parseQuota(input.quotaBytes);
    if (quotaBytes !== undefined && quotaBytes !== 0n && quotaBytes < before.usedBytes) {
      throw this.versionConflict('空间配额不能小于当前已使用容量');
    }

    const after = await this.prisma.$transaction(async (database) => {
      const updated = await database.space.update({
        where: { id: spaceId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(quotaBytes === undefined ? {} : { quotaBytes }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        select: this.spaceSelection(),
      });
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'space.update',
          resourceType: 'SPACE',
          resourceId: spaceId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          beforeData: this.auditData(before),
          afterData: this.auditData(updated),
        },
      });
      return updated;
    });
    return this.serialize(after);
  }

  private async assertOwner(
    actor: AuthenticatedUser,
    input: CreateSpaceDto,
    metadata: AuthorizationRequestMetadata,
  ): Promise<string | null> {
    if (input.ownerType === 'TENANT') {
      if (input.ownerOrganizationId !== undefined) {
        throw this.versionConflict('集团共享空间不能指定所属公司');
      }
      await this.authorization.assert(
        actor,
        'space.create',
        { type: 'TENANT', id: actor.tenantId },
        metadata,
      );
      return null;
    }
    if (input.ownerOrganizationId === undefined) {
      throw this.versionConflict('公司私有空间必须指定所属公司');
    }
    const organization = await this.prisma.organization.findFirst({
      where: { id: input.ownerOrganizationId, tenantId: actor.tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (organization === null) {
      throw this.resourceNotFound();
    }
    await this.authorization.assert(
      actor,
      'space.create',
      { type: 'ORGANIZATION', id: organization.id },
      metadata,
    );
    return organization.id;
  }

  private parseQuota(value: string): bigint {
    const quota = BigInt(value);
    if (quota < 0n || quota > maxInt64) {
      throw this.versionConflict('空间配额超出支持范围');
    }
    return quota;
  }

  private spaceSelection() {
    return {
      id: true,
      code: true,
      name: true,
      ownerType: true,
      ownerOrganizationId: true,
      quotaBytes: true,
      usedBytes: true,
      status: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      ownerOrganization: { select: { code: true, name: true } },
      _count: { select: { members: true, nodes: true } },
    } as const;
  }

  private serialize<T extends { quotaBytes: bigint; usedBytes: bigint }>(space: T) {
    return {
      ...space,
      quotaBytes: space.quotaBytes.toString(),
      usedBytes: space.usedBytes.toString(),
    };
  }

  private auditData(space: {
    code: string;
    name: string;
    ownerType: string;
    ownerOrganizationId: string | null;
    quotaBytes: bigint;
    usedBytes: bigint;
    status: string;
  }) {
    return {
      code: space.code,
      name: space.name,
      ownerType: space.ownerType,
      ownerOrganizationId: space.ownerOrganizationId,
      quotaBytes: space.quotaBytes.toString(),
      usedBytes: space.usedBytes.toString(),
      status: space.status,
    };
  }

  private rethrowConflict(error: unknown, message: string): never {
    if (error instanceof ApiException) {
      throw error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw this.versionConflict(message);
    }
    throw error;
  }

  private versionConflict(message: string): ApiException {
    return new ApiException(HttpStatus.CONFLICT, 'VERSION_CONFLICT', message);
  }

  private resourceNotFound(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'RESOURCE_NOT_FOUND',
      '空间或所属公司不存在，或者你无权查看',
    );
  }
}
