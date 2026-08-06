import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';
import { Prisma } from '@dam/database';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { CreateGroupDto, PageQueryDto, UpdateGroupDto } from './dto/tenant.dto.js';

@Injectable()
export class GroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(actor: AuthenticatedUser, query: PageQueryDto) {
    const subject = await this.authorization.subject(actor);
    const canManageTenant = await this.authorization.can(actor, 'tenant.manage', {
      type: 'TENANT',
      id: actor.tenantId,
    });
    const organizationIds = new Set(
      subject.principals
        .filter((principal) => principal.type === 'ORGANIZATION')
        .map((principal) => principal.id),
    );
    for (const binding of subject.roleBindings) {
      if (
        binding.scopeType === 'ORGANIZATION' &&
        binding.scopeId !== null &&
        binding.permissions.includes('organization.users.manage')
      ) {
        organizationIds.add(binding.scopeId);
      }
    }
    const memberGroupIds = subject.principals
      .filter((principal) => principal.type === 'GROUP')
      .map((principal) => principal.id);
    if (!canManageTenant && organizationIds.size === 0 && memberGroupIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const groups = await this.prisma.group.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(canManageTenant
          ? {}
          : {
              OR: [
                { id: { in: memberGroupIds } },
                { organizationId: { in: [...organizationIds] } },
              ],
            }),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: this.groupSelection(),
    });
    return this.page(groups, query.limit, (group) => group.id);
  }

  async create(
    actor: AuthenticatedUser,
    input: CreateGroupDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    if (input.organizationId === undefined) {
      await this.authorization.assert(
        actor,
        'tenant.manage',
        { type: 'TENANT', id: actor.tenantId },
        metadata,
      );
    } else {
      await this.assertOrganization(actor.tenantId, input.organizationId);
      await this.authorization.assert(
        actor,
        'organization.users.manage',
        { type: 'ORGANIZATION', id: input.organizationId },
        metadata,
      );
    }

    try {
      return await this.prisma.$transaction(async (database) => {
        const group = await database.group.create({
          data: {
            tenantId: actor.tenantId,
            organizationId: input.organizationId ?? null,
            name: input.name.trim(),
            type: input.type ?? 'CUSTOM',
          },
          select: this.groupSelection(),
        });
        await this.authorization.bumpVersion(database, actor.tenantId);
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'group.create',
            resourceType: 'GROUP',
            resourceId: group.id,
            result: 'SUCCEEDED',
            ipAddress: metadata.ipAddress ?? null,
            userAgent: metadata.userAgent ?? null,
            requestId: metadata.requestId ?? null,
            afterData: this.groupAuditData(group),
          },
        });
        return group;
      });
    } catch (error) {
      this.rethrowConflict(error, '群组名称已存在');
    }
  }

  async update(
    actor: AuthenticatedUser,
    groupId: string,
    input: UpdateGroupDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const before = await this.findGroup(actor.tenantId, groupId);
    await this.assertManageGroup(actor, before, metadata);
    if (Object.keys(input).length === 0) {
      return before;
    }

    try {
      return await this.prisma.$transaction(async (database) => {
        const after = await database.group.update({
          where: { id: groupId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.status === undefined ? {} : { status: input.status }),
          },
          select: this.groupSelection(),
        });
        await this.authorization.bumpVersion(database, actor.tenantId);
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'group.update',
            resourceType: 'GROUP',
            resourceId: groupId,
            result: 'SUCCEEDED',
            ipAddress: metadata.ipAddress ?? null,
            userAgent: metadata.userAgent ?? null,
            requestId: metadata.requestId ?? null,
            beforeData: this.groupAuditData(before),
            afterData: this.groupAuditData(after),
          },
        });
        return after;
      });
    } catch (error) {
      this.rethrowConflict(error, '群组名称与现有数据冲突');
    }
  }

  async listMembers(
    actor: AuthenticatedUser,
    groupId: string,
    query: PageQueryDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const group = await this.findGroup(actor.tenantId, groupId);
    await this.assertManageGroup(actor, group, metadata);
    const members = await this.prisma.groupMember.findMany({
      where: { groupId },
      orderBy: { userId: 'asc' },
      take: query.limit + 1,
      ...(query.cursor === undefined
        ? {}
        : { cursor: { groupId_userId: { groupId, userId: query.cursor } }, skip: 1 }),
      select: {
        userId: true,
        joinedAt: true,
        user: {
          select: {
            loginName: true,
            email: true,
            displayName: true,
            status: true,
          },
        },
      },
    });
    return this.page(members, query.limit, (member) => member.userId);
  }

  async addMember(
    actor: AuthenticatedUser,
    groupId: string,
    userId: string,
    metadata: AuthorizationRequestMetadata,
  ) {
    const group = await this.findGroup(actor.tenantId, groupId);
    await this.assertManageGroup(actor, group, metadata);
    if (group.status !== 'ACTIVE') {
      throw this.versionConflict('已停用群组不能添加成员');
    }
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: actor.tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (user === null) {
      throw this.resourceNotFound();
    }
    if (group.organizationId !== null) {
      const membership = await this.prisma.organizationMembership.findFirst({
        where: { organizationId: group.organizationId, userId, status: 'ACTIVE' },
        select: { userId: true },
      });
      if (membership === null) {
        throw this.versionConflict('公司群组成员必须先具备该公司的有效任职');
      }
    }
    const existing = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { userId: true, joinedAt: true },
    });
    if (existing !== null) {
      return existing;
    }

    return this.prisma.$transaction(async (database) => {
      const member = await database.groupMember.create({
        data: { groupId, userId },
        select: { userId: true, joinedAt: true },
      });
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'group.member.add',
          resourceType: 'GROUP',
          resourceId: groupId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          details: { targetUserId: userId },
        },
      });
      return member;
    });
  }

  async removeMember(
    actor: AuthenticatedUser,
    groupId: string,
    userId: string,
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    const group = await this.findGroup(actor.tenantId, groupId);
    await this.assertManageGroup(actor, group, metadata);
    const existing = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { userId: true },
    });
    if (existing === null) {
      return;
    }

    await this.prisma.$transaction(async (database) => {
      await database.groupMember.delete({
        where: { groupId_userId: { groupId, userId } },
      });
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'group.member.remove',
          resourceType: 'GROUP',
          resourceId: groupId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          details: { targetUserId: userId },
        },
      });
    });
  }

  private async findGroup(tenantId: string, groupId: string) {
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, tenantId },
      select: this.groupSelection(),
    });
    if (group === null) {
      throw this.resourceNotFound();
    }
    return group;
  }

  private async assertManageGroup(
    actor: AuthenticatedUser,
    group: { organizationId: string | null },
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    if (group.organizationId === null) {
      await this.authorization.assert(
        actor,
        'tenant.manage',
        { type: 'TENANT', id: actor.tenantId },
        metadata,
      );
      return;
    }
    await this.authorization.assert(
      actor,
      'organization.users.manage',
      { type: 'ORGANIZATION', id: group.organizationId },
      metadata,
    );
  }

  private async assertOrganization(tenantId: string, organizationId: string): Promise<void> {
    const organization = await this.prisma.organization.findFirst({
      where: { id: organizationId, tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (organization === null) {
      throw this.resourceNotFound();
    }
  }

  private groupSelection() {
    return {
      id: true,
      organizationId: true,
      name: true,
      type: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { members: true } },
    } as const;
  }

  private groupAuditData(group: {
    organizationId: string | null;
    name: string;
    type: string;
    status: string;
  }) {
    return {
      organizationId: group.organizationId,
      name: group.name,
      type: group.type,
      status: group.status,
    };
  }

  private page<T>(items: T[], limit: number, id: (item: T) => string) {
    const page = items.slice(0, limit);
    return {
      items: page,
      nextCursor: items.length > limit && page.length > 0 ? id(page[page.length - 1]!) : null,
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
      '群组、公司或用户不存在，或者你无权查看',
    );
  }
}
