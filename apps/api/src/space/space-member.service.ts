import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type {
  SpaceMemberPageQueryDto,
  SpaceMemberParamsDto,
  UpsertSpaceMemberDto,
} from './dto/space.dto.js';

type PrincipalType = SpaceMemberParamsDto['principalType'];

@Injectable()
export class SpaceMemberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(actor: AuthenticatedUser, spaceId: string, query: SpaceMemberPageQueryDto) {
    await this.authorization.assert(actor, 'space.members.manage', { type: 'SPACE', id: spaceId });
    const cursor = this.parseCursor(spaceId, query.cursor);
    const members = await this.prisma.spaceMember.findMany({
      where: { spaceId, space: { tenantId: actor.tenantId } },
      orderBy: [{ principalType: 'asc' }, { principalId: 'asc' }],
      take: query.limit + 1,
      ...(cursor === null
        ? {}
        : { cursor: { spaceId_principalType_principalId: cursor }, skip: 1 }),
      select: {
        principalType: true,
        principalId: true,
        createdAt: true,
        role: { select: { code: true, name: true } },
      },
    });
    const page = members.slice(0, query.limit);
    const principals = await this.principalLabels(actor.tenantId, page);
    return {
      items: page.map((member) => ({
        ...member,
        principal: principals.get(this.principalKey(member)) ?? null,
      })),
      nextCursor:
        members.length > query.limit && page.length > 0
          ? this.principalKey(page[page.length - 1]!)
          : null,
    };
  }

  async upsert(
    actor: AuthenticatedUser,
    spaceId: string,
    principal: SpaceMemberParamsDto,
    input: UpsertSpaceMemberDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'space.members.manage',
      { type: 'SPACE', id: spaceId },
      metadata,
    );
    await this.assertSpace(actor.tenantId, spaceId);
    await this.assertPrincipal(actor.tenantId, principal);
    const [role, existing] = await Promise.all([
      this.prisma.role.findFirst({
        where: {
          code: input.roleCode,
          isSystem: true,
        },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.spaceMember.findUnique({
        where: {
          spaceId_principalType_principalId: {
            spaceId,
            principalType: principal.principalType,
            principalId: principal.principalId,
          },
        },
        select: { role: { select: { code: true } }, createdAt: true },
      }),
    ]);
    if (role === null) {
      throw this.resourceNotFound();
    }
    if (existing?.role.code === 'space_manager' && role.code !== 'space_manager') {
      await this.assertAnotherActiveManager(actor.tenantId, spaceId, principal);
    }
    if (existing?.role.code === role.code) {
      return { ...principal, role, createdAt: existing.createdAt };
    }

    return this.prisma.$transaction(async (database) => {
      const member = await database.spaceMember.upsert({
        where: {
          spaceId_principalType_principalId: {
            spaceId,
            principalType: principal.principalType,
            principalId: principal.principalId,
          },
        },
        update: { roleId: role.id },
        create: {
          spaceId,
          principalType: principal.principalType,
          principalId: principal.principalId,
          roleId: role.id,
        },
        select: {
          principalType: true,
          principalId: true,
          createdAt: true,
          role: { select: { code: true, name: true } },
        },
      });
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'space.member.upsert',
          resourceType: 'SPACE',
          resourceId: spaceId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          ...(existing === null ? {} : { beforeData: { roleCode: existing.role.code } }),
          afterData: {
            principalType: principal.principalType,
            principalId: principal.principalId,
            roleCode: role.code,
          },
        },
      });
      return member;
    });
  }

  async remove(
    actor: AuthenticatedUser,
    spaceId: string,
    principal: SpaceMemberParamsDto,
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    await this.authorization.assert(
      actor,
      'space.members.manage',
      { type: 'SPACE', id: spaceId },
      metadata,
    );
    const existing = await this.prisma.spaceMember.findFirst({
      where: {
        spaceId,
        principalType: principal.principalType,
        principalId: principal.principalId,
        space: { tenantId: actor.tenantId },
      },
      select: { role: { select: { code: true } } },
    });
    if (existing === null) {
      return;
    }
    if (existing.role.code === 'space_manager') {
      await this.assertAnotherActiveManager(actor.tenantId, spaceId, principal);
    }

    await this.prisma.$transaction(async (database) => {
      const removedAclEntries = await database.resourceAclEntry.deleteMany({
        where: {
          tenantId: actor.tenantId,
          principalType: principal.principalType,
          principalId: principal.principalId,
          resourceNode: { spaceId },
        },
      });
      await database.spaceMember.delete({
        where: {
          spaceId_principalType_principalId: {
            spaceId,
            principalType: principal.principalType,
            principalId: principal.principalId,
          },
        },
      });
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'space.member.remove',
          resourceType: 'SPACE',
          resourceId: spaceId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          beforeData: {
            principalType: principal.principalType,
            principalId: principal.principalId,
            roleCode: existing.role.code,
          },
          details: { removedAclEntries: removedAclEntries.count },
        },
      });
    });
  }

  private async assertSpace(tenantId: string, spaceId: string): Promise<void> {
    const space = await this.prisma.space.findFirst({
      where: { id: spaceId, tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (space === null) {
      throw this.resourceNotFound();
    }
  }

  private async assertPrincipal(tenantId: string, principal: SpaceMemberParamsDto): Promise<void> {
    if (!(await this.principalExists(tenantId, principal))) {
      throw this.resourceNotFound();
    }
  }

  private async principalExists(
    tenantId: string,
    principal: SpaceMemberParamsDto,
  ): Promise<boolean> {
    switch (principal.principalType) {
      case 'USER':
        return (
          (await this.prisma.user.findFirst({
            where: { id: principal.principalId, tenantId, status: 'ACTIVE' },
            select: { id: true },
          })) !== null
        );
      case 'GROUP':
        return (
          (await this.prisma.group.findFirst({
            where: { id: principal.principalId, tenantId, status: 'ACTIVE' },
            select: { id: true },
          })) !== null
        );
      case 'ORGANIZATION':
        return (
          (await this.prisma.organization.findFirst({
            where: { id: principal.principalId, tenantId, status: 'ACTIVE' },
            select: { id: true },
          })) !== null
        );
    }
  }

  private async assertAnotherActiveManager(
    tenantId: string,
    spaceId: string,
    excluded: SpaceMemberParamsDto,
  ): Promise<void> {
    const managers = await this.prisma.spaceMember.findMany({
      where: {
        spaceId,
        role: { code: 'space_manager' },
        NOT: { principalType: excluded.principalType, principalId: excluded.principalId },
      },
      select: { principalType: true, principalId: true },
    });
    for (const manager of managers) {
      if (await this.principalExists(tenantId, manager)) {
        return;
      }
    }
    throw new ApiException(
      HttpStatus.CONFLICT,
      'VERSION_CONFLICT',
      '空间必须至少保留一名有效的空间管理员',
    );
  }

  private async principalLabels(
    tenantId: string,
    members: ReadonlyArray<{ principalType: PrincipalType; principalId: string }>,
  ) {
    const userIds = members
      .filter((member) => member.principalType === 'USER')
      .map((member) => member.principalId);
    const groupIds = members
      .filter((member) => member.principalType === 'GROUP')
      .map((member) => member.principalId);
    const organizationIds = members
      .filter((member) => member.principalType === 'ORGANIZATION')
      .map((member) => member.principalId);
    const [users, groups, organizations] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenantId, id: { in: userIds } },
        select: { id: true, displayName: true, status: true },
      }),
      this.prisma.group.findMany({
        where: { tenantId, id: { in: groupIds } },
        select: { id: true, name: true, status: true },
      }),
      this.prisma.organization.findMany({
        where: { tenantId, id: { in: organizationIds } },
        select: { id: true, name: true, status: true },
      }),
    ]);
    return new Map<string, { name: string; status: string }>([
      ...users.map(
        (user) => [`USER:${user.id}`, { name: user.displayName, status: user.status }] as const,
      ),
      ...groups.map(
        (group) => [`GROUP:${group.id}`, { name: group.name, status: group.status }] as const,
      ),
      ...organizations.map(
        (organization) =>
          [
            `ORGANIZATION:${organization.id}`,
            { name: organization.name, status: organization.status },
          ] as const,
      ),
    ]);
  }

  private parseCursor(spaceId: string, cursor?: string) {
    if (cursor === undefined) {
      return null;
    }
    const separator = cursor.indexOf(':');
    return {
      spaceId,
      principalType: cursor.slice(0, separator) as PrincipalType,
      principalId: cursor.slice(separator + 1),
    };
  }

  private principalKey(principal: { principalType: PrincipalType; principalId: string }): string {
    return `${principal.principalType}:${principal.principalId}`;
  }

  private resourceNotFound(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'RESOURCE_NOT_FOUND',
      '空间成员主体不存在，或者你无权查看',
    );
  }
}
