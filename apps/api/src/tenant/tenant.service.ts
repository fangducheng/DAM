import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { UpdateTenantSecurityPolicyDto } from './dto/tenant.dto.js';

@Injectable()
export class TenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async current(actor: AuthenticatedUser) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: actor.tenantId, status: 'ACTIVE' },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        authorizationVersion: true,
        securityPolicy: { select: this.policySelection() },
      },
    });
    if (tenant === null || tenant.securityPolicy === null) {
      throw this.resourceNotFound();
    }
    return {
      ...tenant,
      authorizationVersion: tenant.authorizationVersion.toString(),
      securityPolicy: tenant.securityPolicy,
    };
  }

  async updateSecurityPolicy(
    actor: AuthenticatedUser,
    input: UpdateTenantSecurityPolicyDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    await this.authorization.assert(
      actor,
      'tenant.manage',
      { type: 'TENANT', id: actor.tenantId },
      metadata,
    );
    const before = await this.prisma.tenantSecurityPolicy.findUnique({
      where: { tenantId: actor.tenantId },
      select: this.policySelection(),
    });
    if (before === null) {
      throw this.resourceNotFound();
    }
    if (Object.keys(input).length === 0) {
      return before;
    }

    return this.prisma.$transaction(async (database) => {
      const after = await database.tenantSecurityPolicy.update({
        where: { tenantId: actor.tenantId },
        data: input,
        select: this.policySelection(),
      });
      await this.authorization.bumpVersion(database, actor.tenantId);
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'tenant.security-policy.update',
          resourceType: 'TENANT',
          resourceId: actor.tenantId,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          beforeData: before,
          afterData: after,
        },
      });
      return after;
    });
  }

  private policySelection() {
    return {
      requireAdminMfa: true,
      requireMemberMfa: true,
      accessTokenTtlMinutes: true,
      refreshTokenTtlDays: true,
      maxPasswordAttempts: true,
      passwordLockMinutes: true,
      maxMfaAttempts: true,
      mfaLockMinutes: true,
      invitationTtlHours: true,
    } as const;
  }

  private resourceNotFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '协作域不存在或你无权查看');
  }
}
