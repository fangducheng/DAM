import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';
import { Prisma } from '@dam/database';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type {
  CreateOrganizationDto,
  PageQueryDto,
  UpdateOrganizationDto,
  UpsertOrganizationMembershipDto,
} from './dto/tenant.dto.js';

const organizationRoleCodes = ['organization_admin', 'organization_member'] as const;

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(actor: AuthenticatedUser, query: PageQueryDto) {
    const visibleIds = await this.visibleOrganizationIds(actor);
    const canManageTenant = await this.authorization.can(actor, 'tenant.manage', {
      type: 'TENANT',
      id: actor.tenantId,
    });
    if (!canManageTenant && visibleIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const organizations = await this.prisma.organization.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(canManageTenant ? {} : { id: { in: visibleIds } }),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: this.organizationSelection(),
    });
    return this.page(organizations, query.limit, (organization) => organization.id);
  }

  async get(actor: AuthenticatedUser, organizationId: string) {
    if (!(await this.canView(actor, organizationId))) {
      throw this.resourceNotFound();
    }
    const organization = await this.prisma.organization.findFirst({
      where: { id: organizationId, tenantId: actor.tenantId },
      select: this.organizationSelection(),
    });
    if (organization === null) {
      throw this.resourceNotFound();
    }
    return organization;
  }

  async create(
    actor: AuthenticatedUser,
    input: CreateOrganizationDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'tenant.manage',
      { type: 'TENANT', id: actor.tenantId },
      metadata,
    );
    if (input.parentOrganizationId !== undefined) {
      await this.assertParent(actor.tenantId, input.parentOrganizationId);
    }

    try {
      return await this.prisma.$transaction(async (database) => {
        const created = await database.organization.create({
          data: {
            tenantId: actor.tenantId,
            code: input.code.trim().toLowerCase(),
            name: input.name.trim(),
            parentOrganizationId: input.parentOrganizationId ?? null,
          },
          select: this.organizationSelection(),
        });
        await this.authorization.bumpVersion(database, actor.tenantId);
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'organization.create',
            resourceType: 'ORGANIZATION',
            resourceId: created.id,
            result: 'SUCCEEDED',
            ipAddress: metadata.ipAddress ?? null,
            userAgent: metadata.userAgent ?? null,
            requestId: metadata.requestId ?? null,
            afterData: this.organizationAuditData(created),
          },
        });
        return created;
      });
    } catch (error) {
      this.rethrowConflict(error, '公司代码已存在');
    }
  }

  async update(
    actor: AuthenticatedUser,
    organizationId: string,
    input: UpdateOrganizationDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'organization.manage',
      { type: 'ORGANIZATION', id: organizationId },
      metadata,
    );
    const before = await this.prisma.organization.findFirst({
      where: { id: organizationId, tenantId: actor.tenantId },
      select: this.organizationSelection(),
    });
    if (before === null) {
      throw this.resourceNotFound();
    }
    if (Object.keys(input).length === 0) {
      return before;
    }
    if (Object.hasOwn(input, 'parentOrganizationId')) {
      const parentId = input.parentOrganizationId ?? null;
      if (parentId !== null) {
        await this.assertParent(actor.tenantId, parentId);
        await this.assertNoCycle(actor.tenantId, organizationId, parentId);
      }
    }

    try {
      return await this.prisma.$transaction(async (database) => {
        const after = await database.organization.update({
          where: { id: organizationId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
            ...(Object.hasOwn(input, 'parentOrganizationId')
              ? { parentOrganizationId: input.parentOrganizationId ?? null }
              : {}),
            ...(input.status === undefined ? {} : { status: input.status }),
          },
          select: this.organizationSelection(),
        });
        await this.authorization.bumpVersion(database, actor.tenantId);
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'organization.update',
            resourceType: 'ORGANIZATION',
            resourceId: organizationId,
            result: 'SUCCEEDED',
            ipAddress: metadata.ipAddress ?? null,
            userAgent: metadata.userAgent ?? null,
            requestId: metadata.requestId ?? null,
            beforeData: this.organizationAuditData(before),
            afterData: this.organizationAuditData(after),
          },
        });
        return after;
      });
    } catch (error) {
      this.rethrowConflict(error, '公司信息与现有数据冲突');
    }
  }

  async listMembers(actor: AuthenticatedUser, organizationId: string, query: PageQueryDto) {
    await this.authorization.assert(actor, 'organization.users.manage', {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    const memberships = await this.prisma.organizationMembership.findMany({
      where: { organizationId, organization: { tenantId: actor.tenantId } },
      orderBy: { userId: 'asc' },
      take: query.limit + 1,
      ...(query.cursor === undefined
        ? {}
        : {
            cursor: {
              organizationId_userId: { organizationId, userId: query.cursor },
            },
            skip: 1,
          }),
      select: {
        userId: true,
        title: true,
        isPrimary: true,
        status: true,
        joinedAt: true,
        updatedAt: true,
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
    const page = memberships.slice(0, query.limit);
    const bindings = await this.prisma.roleBinding.findMany({
      where: {
        tenantId: actor.tenantId,
        scopeType: 'ORGANIZATION',
        scopeId: organizationId,
        principalType: 'USER',
        principalId: { in: page.map(({ userId }) => userId) },
        role: { code: { in: [...organizationRoleCodes] } },
      },
      select: { principalId: true, role: { select: { code: true } } },
    });
    const roles = new Map(bindings.map((binding) => [binding.principalId, binding.role.code]));
    return {
      items: page.map((membership) => ({
        ...membership,
        roleCode: roles.get(membership.userId) ?? null,
      })),
      nextCursor: memberships.length > query.limit ? (page.at(-1)?.userId ?? null) : null,
    };
  }

  async upsertMember(
    actor: AuthenticatedUser,
    organizationId: string,
    userId: string,
    input: UpsertOrganizationMembershipDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'organization.users.manage',
      { type: 'ORGANIZATION', id: organizationId },
      metadata,
    );
    const [organization, user, role, existing] = await Promise.all([
      this.prisma.organization.findFirst({
        where: { id: organizationId, tenantId: actor.tenantId, status: 'ACTIVE' },
        select: { id: true },
      }),
      this.prisma.user.findFirst({
        where: { id: userId, tenantId: actor.tenantId, status: 'ACTIVE' },
        select: { id: true },
      }),
      this.prisma.role.findFirst({
        where: { code: input.roleCode, isSystem: true },
        select: { id: true },
      }),
      this.prisma.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { title: true, isPrimary: true, status: true },
      }),
    ]);
    if (organization === null || user === null || role === null) {
      throw this.resourceNotFound();
    }

    const desiredStatus = input.status ?? 'ACTIVE';
    const existingAdmin = await this.hasOrganizationAdminBinding(organizationId, userId);
    if (existingAdmin && (desiredStatus !== 'ACTIVE' || input.roleCode !== 'organization_admin')) {
      await this.assertAnotherAdministrator(organizationId, userId);
    }
    const activeMembershipCount = await this.prisma.organizationMembership.count({
      where: { userId, status: 'ACTIVE' },
    });
    const isPrimary =
      desiredStatus === 'ACTIVE' &&
      (input.isPrimary ?? existing?.isPrimary ?? activeMembershipCount === 0);

    try {
      return await this.prisma.$transaction(async (database) => {
        if (isPrimary) {
          await database.organizationMembership.updateMany({
            where: { userId, organizationId: { not: organizationId }, isPrimary: true },
            data: { isPrimary: false },
          });
        }
        const membership = await database.organizationMembership.upsert({
          where: { organizationId_userId: { organizationId, userId } },
          update: {
            status: desiredStatus,
            isPrimary,
            ...(input.title === undefined ? {} : { title: input.title?.trim() ?? null }),
          },
          create: {
            organizationId,
            userId,
            status: desiredStatus,
            isPrimary,
            title: input.title?.trim() ?? null,
          },
          select: { userId: true, title: true, isPrimary: true, status: true, joinedAt: true },
        });
        await database.roleBinding.deleteMany({
          where: {
            tenantId: actor.tenantId,
            scopeType: 'ORGANIZATION',
            scopeId: organizationId,
            principalType: 'USER',
            principalId: userId,
            role: { code: { in: [...organizationRoleCodes] } },
          },
        });
        if (desiredStatus === 'ACTIVE') {
          await database.roleBinding.create({
            data: {
              tenantId: actor.tenantId,
              roleId: role.id,
              principalType: 'USER',
              principalId: userId,
              scopeType: 'ORGANIZATION',
              scopeId: organizationId,
            },
          });
        } else if (existing?.isPrimary === true) {
          await this.assignReplacementPrimary(database, userId, organizationId);
        }
        await this.authorization.bumpVersion(database, actor.tenantId);
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'organization.membership.upsert',
            resourceType: 'ORGANIZATION',
            resourceId: organizationId,
            result: 'SUCCEEDED',
            ipAddress: metadata.ipAddress ?? null,
            userAgent: metadata.userAgent ?? null,
            requestId: metadata.requestId ?? null,
            ...(existing === null ? {} : { beforeData: existing }),
            afterData: {
              ...membership,
              joinedAt: membership.joinedAt.toISOString(),
              roleCode: input.roleCode,
            },
            details: { targetUserId: userId },
          },
        });
        return { ...membership, roleCode: desiredStatus === 'ACTIVE' ? input.roleCode : null };
      });
    } catch (error) {
      this.rethrowConflict(error, '任职关系与现有数据冲突');
    }
  }

  async removeMember(
    actor: AuthenticatedUser,
    organizationId: string,
    userId: string,
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    await this.authorization.assert(
      actor,
      'organization.users.manage',
      { type: 'ORGANIZATION', id: organizationId },
      metadata,
    );
    const existing = await this.prisma.organizationMembership.findFirst({
      where: { organizationId, userId, organization: { tenantId: actor.tenantId } },
      select: { title: true, isPrimary: true, status: true },
    });
    if (existing === null) {
      throw this.resourceNotFound();
    }
    if (existing.status === 'DISABLED') {
      return;
    }
    if (await this.hasOrganizationAdminBinding(organizationId, userId)) {
      await this.assertAnotherAdministrator(organizationId, userId);
    }

    await this.prisma.$transaction(async (database) => {
      await database.organizationMembership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { status: 'DISABLED', isPrimary: false },
      });
      await database.roleBinding.deleteMany({
        where: {
          tenantId: actor.tenantId,
          scopeType: 'ORGANIZATION',
          scopeId: organizationId,
          principalType: 'USER',
          principalId: userId,
          role: { code: { in: [...organizationRoleCodes] } },
        },
      });
      if (existing.isPrimary) {
        await this.assignReplacementPrimary(database, userId, organizationId);
      }
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'organization.membership.disable',
          resourceType: 'ORGANIZATION',
          resourceId: organizationId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          beforeData: existing,
          afterData: { ...existing, isPrimary: false, status: 'DISABLED' },
          details: { targetUserId: userId },
        },
      });
    });
  }

  private async canView(actor: AuthenticatedUser, organizationId: string): Promise<boolean> {
    if (
      await this.authorization.can(actor, 'organization.manage', {
        type: 'ORGANIZATION',
        id: organizationId,
      })
    ) {
      return true;
    }
    const subject = await this.authorization.subject(actor);
    return subject.principals.some(
      (principal) => principal.type === 'ORGANIZATION' && principal.id === organizationId,
    );
  }

  private async visibleOrganizationIds(actor: AuthenticatedUser): Promise<string[]> {
    const subject = await this.authorization.subject(actor);
    return [
      ...new Set([
        ...subject.principals
          .filter((principal) => principal.type === 'ORGANIZATION')
          .map((principal) => principal.id),
        ...subject.roleBindings
          .filter(
            (binding) =>
              binding.scopeType === 'ORGANIZATION' &&
              binding.scopeId !== null &&
              (binding.permissions.includes('organization.manage') ||
                binding.permissions.includes('organization.users.manage')),
          )
          .map((binding) => binding.scopeId!),
      ]),
    ];
  }

  private async assertParent(tenantId: string, parentId: string): Promise<void> {
    const parent = await this.prisma.organization.findFirst({
      where: { id: parentId, tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (parent === null) {
      throw this.resourceNotFound();
    }
  }

  private async assertNoCycle(
    tenantId: string,
    organizationId: string,
    proposedParentId: string,
  ): Promise<void> {
    let cursor: string | null = proposedParentId;
    const visited = new Set<string>();
    while (cursor !== null) {
      if (cursor === organizationId || visited.has(cursor)) {
        throw this.versionConflict('公司层级不能形成循环');
      }
      visited.add(cursor);
      const current: { parentOrganizationId: string | null } | null =
        await this.prisma.organization.findFirst({
          where: { id: cursor, tenantId },
          select: { parentOrganizationId: true },
        });
      if (current === null) {
        throw this.resourceNotFound();
      }
      cursor = current.parentOrganizationId;
    }
  }

  private async hasOrganizationAdminBinding(
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    return (
      (await this.prisma.roleBinding.findFirst({
        where: {
          scopeType: 'ORGANIZATION',
          scopeId: organizationId,
          principalType: 'USER',
          principalId: userId,
          role: { code: 'organization_admin' },
        },
        select: { id: true },
      })) !== null
    );
  }

  private async assertAnotherAdministrator(
    organizationId: string,
    excludedUserId: string,
  ): Promise<void> {
    const activeMembers = await this.prisma.organizationMembership.findMany({
      where: { organizationId, status: 'ACTIVE', userId: { not: excludedUserId } },
      select: { userId: true },
    });
    const replacement = await this.prisma.roleBinding.findFirst({
      where: {
        scopeType: 'ORGANIZATION',
        scopeId: organizationId,
        principalType: 'USER',
        principalId: { in: activeMembers.map(({ userId }) => userId) },
        role: { code: 'organization_admin' },
      },
      select: { id: true },
    });
    if (replacement === null) {
      throw this.versionConflict('必须至少保留一名公司管理员');
    }
  }

  private async assignReplacementPrimary(
    database: Prisma.TransactionClient,
    userId: string,
    excludedOrganizationId: string,
  ): Promise<void> {
    const replacement = await database.organizationMembership.findFirst({
      where: { userId, organizationId: { not: excludedOrganizationId }, status: 'ACTIVE' },
      orderBy: { joinedAt: 'asc' },
      select: { organizationId: true },
    });
    if (replacement !== null) {
      await database.organizationMembership.update({
        where: {
          organizationId_userId: { organizationId: replacement.organizationId, userId },
        },
        data: { isPrimary: true },
      });
    }
  }

  private organizationSelection() {
    return {
      id: true,
      code: true,
      name: true,
      status: true,
      parentOrganizationId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { memberships: true, groups: true, ownedSpaces: true } },
    } as const;
  }

  private organizationAuditData(organization: {
    code: string;
    name: string;
    status: string;
    parentOrganizationId: string | null;
  }) {
    return {
      code: organization.code,
      name: organization.name,
      status: organization.status,
      parentOrganizationId: organization.parentOrganizationId,
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
      '公司或用户不存在，或者你无权查看',
    );
  }
}
