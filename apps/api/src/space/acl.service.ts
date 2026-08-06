import { HttpStatus, Injectable } from '@nestjs/common';

import { permissionCodes, type AuthenticatedUser, type PermissionCode } from '@dam/contracts';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { AclListQueryDto, UpsertResourceAclDto } from './dto/space.dto.js';

const nodePermissions = new Set<PermissionCode>(
  permissionCodes.filter((code) => code.startsWith('node.')),
);

@Injectable()
export class AclService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(actor: AuthenticatedUser, nodeId: string, query: AclListQueryDto) {
    await this.authorization.assert(actor, 'node.permissions.manage', {
      type: 'NODE',
      id: nodeId,
    });
    await this.assertNode(actor.tenantId, nodeId);
    const ancestors = await this.prisma.resourceClosure.findMany({
      where: { descendantId: nodeId, ...(query.includeInherited ? {} : { depth: 0 }) },
      orderBy: { depth: 'asc' },
      select: {
        depth: true,
        ancestor: {
          select: {
            id: true,
            name: true,
            aclEntries: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                principalType: true,
                principalId: true,
                effect: true,
                expiresAt: true,
                createdAt: true,
                permission: { select: { code: true, name: true } },
                createdBy: { select: { id: true, displayName: true } },
              },
            },
          },
        },
      },
    });
    return {
      items: ancestors.flatMap(({ ancestor, depth }) =>
        ancestor.aclEntries.map((entry) => ({
          ...entry,
          sourceNode: { id: ancestor.id, name: ancestor.name },
          depth,
          inherited: depth > 0,
        })),
      ),
    };
  }

  async upsert(
    actor: AuthenticatedUser,
    nodeId: string,
    input: UpsertResourceAclDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'node.permissions.manage',
      { type: 'NODE', id: nodeId },
      metadata,
    );
    const node = await this.assertNode(actor.tenantId, nodeId);
    if (!nodePermissions.has(input.permissionCode)) {
      throw this.versionConflict('该权限不能用于文件夹或文件 ACL');
    }
    await this.assertActivePrincipal(actor.tenantId, input.principalType, input.principalId);
    const [spaceMember, permission] = await Promise.all([
      this.prisma.spaceMember.findUnique({
        where: {
          spaceId_principalType_principalId: {
            spaceId: node.spaceId,
            principalType: input.principalType,
            principalId: input.principalId,
          },
        },
        select: { roleId: true },
      }),
      this.prisma.permission.findUnique({
        where: { code: input.permissionCode },
        select: { id: true },
      }),
    ]);
    if (spaceMember === null || permission === null) {
      throw this.versionConflict('ACL 主体必须先作为直接成员加入空间');
    }
    const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt);
    if (expiresAt !== null && expiresAt <= new Date()) {
      throw this.versionConflict('ACL 过期时间必须晚于当前时间');
    }
    const existing = await this.prisma.resourceAclEntry.findUnique({
      where: {
        resourceNodeId_principalType_principalId_permissionId: {
          resourceNodeId: nodeId,
          principalType: input.principalType,
          principalId: input.principalId,
          permissionId: permission.id,
        },
      },
      select: this.aclSelection(),
    });

    return this.prisma.$transaction(async (database) => {
      const entry = await database.resourceAclEntry.upsert({
        where: {
          resourceNodeId_principalType_principalId_permissionId: {
            resourceNodeId: nodeId,
            principalType: input.principalType,
            principalId: input.principalId,
            permissionId: permission.id,
          },
        },
        update: { effect: input.effect, expiresAt, createdById: actor.userId },
        create: {
          tenantId: actor.tenantId,
          resourceNodeId: nodeId,
          principalType: input.principalType,
          principalId: input.principalId,
          permissionId: permission.id,
          effect: input.effect,
          expiresAt,
          createdById: actor.userId,
        },
        select: this.aclSelection(),
      });
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'resource.acl.upsert',
          resourceType: 'RESOURCE_NODE',
          resourceId: nodeId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          ...(existing === null ? {} : { beforeData: this.auditData(existing) }),
          afterData: this.auditData(entry),
        },
      });
      return entry;
    });
  }

  async remove(
    actor: AuthenticatedUser,
    nodeId: string,
    aclEntryId: string,
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    await this.authorization.assert(
      actor,
      'node.permissions.manage',
      { type: 'NODE', id: nodeId },
      metadata,
    );
    const existing = await this.prisma.resourceAclEntry.findFirst({
      where: { id: aclEntryId, resourceNodeId: nodeId, tenantId: actor.tenantId },
      select: this.aclSelection(),
    });
    if (existing === null) {
      throw this.resourceNotFound();
    }
    await this.prisma.$transaction(async (database) => {
      await database.resourceAclEntry.delete({ where: { id: aclEntryId } });
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'resource.acl.remove',
          resourceType: 'RESOURCE_NODE',
          resourceId: nodeId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          beforeData: this.auditData(existing),
        },
      });
    });
  }

  async explain(actor: AuthenticatedUser, nodeId: string, permission: PermissionCode) {
    if (!nodePermissions.has(permission)) {
      throw this.resourceNotFound();
    }
    if (!(await this.authorization.can(actor, 'node.view', { type: 'NODE', id: nodeId }))) {
      throw this.resourceNotFound();
    }
    return this.authorization.evaluate(actor, permission, { type: 'NODE', id: nodeId });
  }

  private async assertNode(tenantId: string, nodeId: string) {
    const node = await this.prisma.resourceNode.findFirst({
      where: { id: nodeId, space: { tenantId }, status: 'ACTIVE' },
      select: { id: true, spaceId: true },
    });
    if (node === null) {
      throw this.resourceNotFound();
    }
    return node;
  }

  private async assertActivePrincipal(
    tenantId: string,
    principalType: UpsertResourceAclDto['principalType'],
    principalId: string,
  ): Promise<void> {
    const exists =
      principalType === 'USER'
        ? await this.prisma.user.findFirst({
            where: { id: principalId, tenantId, status: 'ACTIVE' },
            select: { id: true },
          })
        : principalType === 'GROUP'
          ? await this.prisma.group.findFirst({
              where: { id: principalId, tenantId, status: 'ACTIVE' },
              select: { id: true },
            })
          : await this.prisma.organization.findFirst({
              where: { id: principalId, tenantId, status: 'ACTIVE' },
              select: { id: true },
            });
    if (exists === null) {
      throw this.resourceNotFound();
    }
  }

  private aclSelection() {
    return {
      id: true,
      resourceNodeId: true,
      principalType: true,
      principalId: true,
      effect: true,
      expiresAt: true,
      createdAt: true,
      permission: { select: { code: true, name: true } },
      createdBy: { select: { id: true, displayName: true } },
    } as const;
  }

  private auditData(entry: {
    principalType: string;
    principalId: string;
    effect: string;
    expiresAt: Date | null;
    permission: { code: string };
  }) {
    return {
      principalType: entry.principalType,
      principalId: entry.principalId,
      permissionCode: entry.permission.code,
      effect: entry.effect,
      expiresAt: entry.expiresAt?.toISOString() ?? null,
    };
  }

  private versionConflict(message: string): ApiException {
    return new ApiException(HttpStatus.CONFLICT, 'VERSION_CONFLICT', message);
  }

  private resourceNotFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '资源不存在或你无权查看');
  }
}
