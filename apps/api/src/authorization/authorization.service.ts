import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { permissionCodes, type AuthenticatedUser, type PermissionCode } from '@dam/contracts';
import type { Prisma } from '@dam/database';

import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { RedisService } from '../infrastructure/redis.service.js';
import { AuthorizationPolicy } from './authorization.policy.js';
import type {
  ApplicableAclEntry,
  AuthorizationExplanation,
  AuthorizationRequestMetadata,
  AuthorizationScope,
  AuthorizationSubject,
  CachedRoleBinding,
  ResolvedPrincipal,
} from './authorization.types.js';

interface ScopeContext {
  spaceId: string | null;
  ownerOrganizationId: string | null;
}

interface SpaceRoleGrant {
  roleCode: string;
  permissions: PermissionCode[];
}

const knownPermissions = new Set<string>(permissionCodes);

@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);
  private readonly cacheTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly policy: AuthorizationPolicy,
    config: ConfigService,
  ) {
    this.cacheTtlSeconds = config.getOrThrow<number>('AUTHORIZATION_CACHE_TTL_SECONDS');
  }

  async assert(
    actor: AuthenticatedUser,
    permission: PermissionCode,
    scope: AuthorizationScope,
    metadata: AuthorizationRequestMetadata = {},
  ): Promise<AuthorizationExplanation> {
    const explanation = await this.evaluate(actor, permission, scope);
    if (explanation.allowed) {
      return explanation;
    }

    await this.auditDenied(actor, explanation, metadata);
    throw new ApiException(HttpStatus.FORBIDDEN, 'ACCESS_DENIED', '无权执行此操作');
  }

  async can(
    actor: AuthenticatedUser,
    permission: PermissionCode,
    scope: AuthorizationScope,
  ): Promise<boolean> {
    try {
      return (await this.evaluate(actor, permission, scope)).allowed;
    } catch (error) {
      if (error instanceof ApiException && error.code === 'RESOURCE_NOT_FOUND') {
        return false;
      }
      throw error;
    }
  }

  async evaluate(
    actor: AuthenticatedUser,
    permission: PermissionCode,
    scope: AuthorizationScope,
  ): Promise<AuthorizationExplanation> {
    const subject = await this.subject(actor);
    const context = await this.resolveScope(actor.tenantId, scope);
    const now = new Date();
    const scopedBindings = subject.roleBindings.filter(
      (binding) =>
        (binding.expiresAt === null || new Date(binding.expiresAt) > now) &&
        this.bindingApplies(binding, scope, context),
    );
    const spaceRoles =
      context.spaceId === null
        ? []
        : await this.spaceRoleGrants(context.spaceId, subject.principals);
    const roleGrants = [
      ...scopedBindings.map((binding) => ({
        roleCode: binding.roleCode,
        permissions: binding.permissions,
      })),
      ...spaceRoles,
    ];
    const rolePermissions = [...new Set(roleGrants.flatMap((grant) => grant.permissions))];
    const hasSpaceEntry =
      context.spaceId === null ||
      spaceRoles.length > 0 ||
      scopedBindings.some(
        (binding) =>
          binding.scopeType === 'PLATFORM' ||
          binding.scopeType === 'SPACE' ||
          binding.permissions.includes(permission),
      );
    const aclEntries =
      scope.type === 'NODE' && hasSpaceEntry
        ? await this.aclEntries(scope.id, permission, subject.principals)
        : [];
    const decision = hasSpaceEntry
      ? this.policy.evaluate({ permission, rolePermissions, aclEntries, evaluatedAt: now })
      : { allowed: false, reason: 'default_deny' as const, matchedAclEntryIds: [] };
    const matchedIds = new Set(decision.matchedAclEntryIds);

    return {
      ...decision,
      permission,
      scope,
      authorizationVersion: subject.authorizationVersion,
      roleCodes: [
        ...new Set(
          roleGrants
            .filter((grant) => grant.permissions.includes(permission))
            .map((grant) => grant.roleCode),
        ),
      ],
      matchedAclEntries: aclEntries
        .filter((entry) => matchedIds.has(entry.id))
        .map(({ id, effect, resourceNodeId, depth }) => ({ id, effect, resourceNodeId, depth })),
    };
  }

  async subject(actor: AuthenticatedUser): Promise<AuthorizationSubject> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: actor.tenantId, status: 'ACTIVE' },
      select: { authorizationVersion: true },
    });
    if (tenant === null) {
      throw this.resourceNotFound();
    }

    const authorizationVersion = tenant.authorizationVersion.toString();
    const cacheKey = `dam:authorization:subject:${actor.tenantId}:${authorizationVersion}:${actor.userId}`;
    try {
      const cached = await this.redis.getJson<AuthorizationSubject>(cacheKey);
      if (cached !== null) {
        return cached;
      }
    } catch (error) {
      this.logger.warn(`Authorization cache read failed: ${this.errorMessage(error)}`);
    }

    const user = await this.prisma.user.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId, status: 'ACTIVE' },
      select: {
        organizationMembers: {
          where: { status: 'ACTIVE', organization: { status: 'ACTIVE' } },
          select: { organizationId: true },
        },
        groupMemberships: {
          where: { group: { tenantId: actor.tenantId, status: 'ACTIVE' } },
          select: { group: { select: { id: true, organizationId: true } } },
        },
      },
    });
    if (user === null) {
      throw this.resourceNotFound();
    }

    const organizationIds = new Set(
      user.organizationMembers.map((membership) => membership.organizationId),
    );
    const groupIds = user.groupMemberships
      .filter(
        ({ group }) => group.organizationId === null || organizationIds.has(group.organizationId),
      )
      .map(({ group }) => group.id);
    const principals: ResolvedPrincipal[] = [
      { type: 'USER', id: actor.userId },
      ...[...organizationIds].map((id) => ({ type: 'ORGANIZATION' as const, id })),
      ...groupIds.map((id) => ({ type: 'GROUP' as const, id })),
    ];
    const bindings = await this.prisma.roleBinding.findMany({
      where: {
        AND: [
          { OR: principals.map(({ type, id }) => ({ principalType: type, principalId: id })) },
          { OR: [{ tenantId: actor.tenantId }, { scopeType: 'PLATFORM', tenantId: null }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ],
      },
      select: {
        scopeType: true,
        scopeId: true,
        expiresAt: true,
        role: {
          select: {
            code: true,
            permissions: { select: { permission: { select: { code: true } } } },
          },
        },
      },
    });
    const subject: AuthorizationSubject = {
      authorizationVersion,
      principals,
      roleBindings: bindings.map((binding) => ({
        scopeType: binding.scopeType,
        scopeId: binding.scopeId,
        roleCode: binding.role.code,
        permissions: binding.role.permissions
          .map(({ permission }) => permission.code)
          .filter((code): code is PermissionCode => knownPermissions.has(code)),
        expiresAt: binding.expiresAt?.toISOString() ?? null,
      })),
    };

    try {
      await this.redis.setJson(cacheKey, subject, this.cacheTtlSeconds);
    } catch (error) {
      this.logger.warn(`Authorization cache write failed: ${this.errorMessage(error)}`);
    }
    return subject;
  }

  async bumpVersion(database: Prisma.TransactionClient, tenantId: string): Promise<void> {
    await database.tenant.update({
      where: { id: tenantId },
      data: { authorizationVersion: { increment: 1 } },
      select: { id: true },
    });
  }

  private async resolveScope(tenantId: string, scope: AuthorizationScope): Promise<ScopeContext> {
    switch (scope.type) {
      case 'TENANT': {
        if (scope.id !== tenantId) {
          throw this.resourceNotFound();
        }
        return { spaceId: null, ownerOrganizationId: null };
      }
      case 'ORGANIZATION': {
        const organization = await this.prisma.organization.findFirst({
          where: { id: scope.id, tenantId },
          select: { id: true },
        });
        if (organization === null) {
          throw this.resourceNotFound();
        }
        return { spaceId: null, ownerOrganizationId: organization.id };
      }
      case 'SPACE': {
        const space = await this.prisma.space.findFirst({
          where: { id: scope.id, tenantId },
          select: { id: true, ownerOrganizationId: true },
        });
        if (space === null) {
          throw this.resourceNotFound();
        }
        return { spaceId: space.id, ownerOrganizationId: space.ownerOrganizationId };
      }
      case 'NODE': {
        const node = await this.prisma.resourceNode.findFirst({
          where: { id: scope.id, space: { tenantId } },
          select: { spaceId: true, space: { select: { ownerOrganizationId: true } } },
        });
        if (node === null) {
          throw this.resourceNotFound();
        }
        return { spaceId: node.spaceId, ownerOrganizationId: node.space.ownerOrganizationId };
      }
    }
  }

  private bindingApplies(
    binding: CachedRoleBinding,
    scope: AuthorizationScope,
    context: ScopeContext,
  ): boolean {
    if (binding.scopeType === 'PLATFORM') {
      return true;
    }
    if (binding.scopeType === 'TENANT') {
      return binding.scopeId !== null;
    }
    if (binding.scopeType === 'ORGANIZATION') {
      return (
        (scope.type === 'ORGANIZATION' && binding.scopeId === scope.id) ||
        (context.ownerOrganizationId !== null && binding.scopeId === context.ownerOrganizationId)
      );
    }
    return context.spaceId !== null && binding.scopeId === context.spaceId;
  }

  private async spaceRoleGrants(
    spaceId: string,
    principals: readonly ResolvedPrincipal[],
  ): Promise<SpaceRoleGrant[]> {
    const members = await this.prisma.spaceMember.findMany({
      where: {
        spaceId,
        OR: principals.map(({ type, id }) => ({ principalType: type, principalId: id })),
      },
      select: {
        role: {
          select: {
            code: true,
            permissions: { select: { permission: { select: { code: true } } } },
          },
        },
      },
    });
    return members.map(({ role }) => ({
      roleCode: role.code,
      permissions: role.permissions
        .map(({ permission }) => permission.code)
        .filter((code): code is PermissionCode => knownPermissions.has(code)),
    }));
  }

  private async aclEntries(
    nodeId: string,
    permission: PermissionCode,
    principals: readonly ResolvedPrincipal[],
  ): Promise<ApplicableAclEntry[]> {
    const ancestors = await this.prisma.resourceClosure.findMany({
      where: { descendantId: nodeId },
      select: {
        depth: true,
        ancestor: {
          select: {
            id: true,
            aclEntries: {
              where: {
                permission: { code: permission },
                OR: principals.map(({ type, id }) => ({ principalType: type, principalId: id })),
              },
              select: { id: true, effect: true, expiresAt: true },
            },
          },
        },
      },
    });
    return ancestors.flatMap(({ ancestor, depth }) =>
      ancestor.aclEntries.map((entry) => ({
        id: entry.id,
        permission,
        effect: entry.effect,
        resourceNodeId: ancestor.id,
        depth,
        expiresAt: entry.expiresAt,
      })),
    );
  }

  private async auditDenied(
    actor: AuthenticatedUser,
    explanation: AuthorizationExplanation,
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'authorization.access.denied',
          resourceType: explanation.scope.type,
          resourceId: explanation.scope.id,
          result: 'DENIED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          details: {
            permission: explanation.permission,
            reason: explanation.reason,
            authorizationVersion: explanation.authorizationVersion,
          },
        },
      });
    } catch (error) {
      this.logger.error(`Authorization denial audit failed: ${this.errorMessage(error)}`);
    }
  }

  private resourceNotFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '资源不存在或你无权查看');
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
