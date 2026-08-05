import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';
import type { Prisma } from '@dam/database';

import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { IdentityRequestMetadata } from './identity.types.js';
import { PasswordService } from './security/password.service.js';
import { SecurityCryptoService } from './security/security-crypto.service.js';
import { TotpService } from './security/totp.service.js';

type InvitationType = 'TENANT_ADMIN' | 'ORGANIZATION_MEMBER';

export interface CreateInvitationInput {
  type: InvitationType;
  organizationId?: string;
  email: string;
  loginName: string;
  displayName: string;
  initialRoleCode: string;
}

export interface CreatedInvitation {
  id: string;
  token: string;
  expiresAt: Date;
}

export interface InvitationAcceptance {
  accepted: boolean;
  mfaVerificationRequired: boolean;
  provisioningUri?: string;
}

export interface ConfirmedInvitation {
  accepted: true;
  recoveryCodes: string[];
}

@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly crypto: SecurityCryptoService,
    private readonly totp: TotpService,
  ) {}

  async create(
    actor: AuthenticatedUser,
    input: CreateInvitationInput,
    metadata: IdentityRequestMetadata,
  ): Promise<CreatedInvitation> {
    this.assertMfa(actor);
    const organization =
      input.organizationId === undefined
        ? null
        : await this.prisma.organization.findFirst({
            where: { id: input.organizationId, tenantId: actor.tenantId, status: 'ACTIVE' },
            select: { id: true },
          });
    if (input.type === 'ORGANIZATION_MEMBER' && organization === null) {
      throw this.resourceNotFound();
    }
    if (input.type === 'TENANT_ADMIN' && input.organizationId !== undefined) {
      throw this.invalidInvitation('租户管理员邀请不能指定公司');
    }

    await this.assertCanManageInvitations(actor, input.type, organization?.id);
    const initialRole = await this.prisma.role.findFirst({
      where: { code: input.initialRoleCode, isSystem: true },
      select: { id: true, code: true },
    });
    if (initialRole === null || !this.roleAllowed(input.type, initialRole.code)) {
      throw this.invalidInvitation('初始角色与邀请类型不匹配');
    }

    const tenantPolicy = await this.prisma.tenantSecurityPolicy.findUnique({
      where: { tenantId: actor.tenantId },
      select: { invitationTtlHours: true },
    });
    const token = this.crypto.randomToken(32);
    const tokenHash = this.crypto.hashToken(token);
    const expiresAt = new Date(Date.now() + (tenantPolicy?.invitationTtlHours ?? 24) * 3_600_000);
    const email = input.email.trim().toLowerCase();
    const loginName = input.loginName.trim().toLowerCase();

    const invitation = await this.prisma.$transaction(async (database) => {
      await database.invitation.updateMany({
        where: {
          tenantId: actor.tenantId,
          organizationId: organization?.id ?? null,
          email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      const created = await database.invitation.create({
        data: {
          tenantId: actor.tenantId,
          organizationId: organization?.id ?? null,
          initialRoleId: initialRole.id,
          invitedById: actor.userId,
          type: input.type,
          email,
          loginName,
          displayName: input.displayName.trim(),
          tokenHash,
          expiresAt,
        },
      });
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'identity.invitation.create',
          resourceType: 'INVITATION',
          resourceId: created.id,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          details: { type: input.type, organizationId: organization?.id ?? null },
        },
      });
      return created;
    });

    return { id: invitation.id, token, expiresAt };
  }

  async revoke(
    actor: AuthenticatedUser,
    invitationId: string,
    metadata: IdentityRequestMetadata,
  ): Promise<void> {
    this.assertMfa(actor);
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, tenantId: actor.tenantId },
      select: { id: true, type: true, organizationId: true, acceptedAt: true, revokedAt: true },
    });
    if (invitation === null) {
      throw this.resourceNotFound();
    }
    await this.assertCanManageInvitations(
      actor,
      invitation.type,
      invitation.organizationId ?? undefined,
    );
    if (invitation.acceptedAt !== null || invitation.revokedAt !== null) {
      return;
    }

    await this.prisma.$transaction([
      this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { revokedAt: new Date() },
      }),
      this.prisma.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'identity.invitation.revoke',
          resourceType: 'INVITATION',
          resourceId: invitation.id,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
        },
      }),
    ]);
  }

  async accept(token: string, password: string): Promise<InvitationAcceptance> {
    const invitation = await this.findUsableInvitation(token);
    const existingUser = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: invitation.tenantId, email: invitation.email } },
      select: { id: true, status: true, credential: true },
    });
    if (
      existingUser !== null &&
      (existingUser.status === 'DISABLED' || existingUser.status === 'LOCKED')
    ) {
      throw this.invalidInvitation('该账号当前不可接受邀请');
    }
    if (existingUser === null && invitation.loginName !== null) {
      const loginOwner = await this.prisma.user.findUnique({
        where: {
          tenantId_loginName: {
            tenantId: invitation.tenantId,
            loginName: invitation.loginName,
          },
        },
        select: { id: true },
      });
      if (loginOwner !== null) {
        throw this.invalidInvitation('登录名已被其他账号使用，请联系管理员重新邀请');
      }
    }

    let passwordHash: string | null = null;
    if (existingUser?.credential === null || existingUser === null) {
      try {
        passwordHash = await this.passwords.hash(password);
      } catch {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', '密码不符合安全策略');
      }
    } else if (!(await this.passwords.verify(existingUser.credential.passwordHash, password))) {
      throw this.invalidInvitation('邀请或账号凭据无效');
    }

    const user = await this.prisma.$transaction(async (database) => {
      if (existingUser === null) {
        return database.user.create({
          data: {
            tenantId: invitation.tenantId,
            loginName: invitation.loginName ?? invitation.email,
            email: invitation.email,
            displayName: invitation.displayName ?? invitation.email,
            status: 'INVITED',
            credential: { create: { passwordHash: passwordHash! } },
          },
          select: { id: true, status: true },
        });
      }
      if (existingUser.credential === null) {
        await database.userCredential.create({
          data: { userId: existingUser.id, passwordHash: passwordHash! },
        });
      }
      return { id: existingUser.id, status: existingUser.status };
    });

    const requireMfa =
      invitation.tenant.securityPolicy?.requireMemberMfa === true ||
      this.isAdministrativeRole(invitation.initialRole.code);
    if (!requireMfa) {
      await this.prisma.$transaction((database) => this.finalize(database, invitation, user.id));
      return { accepted: true, mfaVerificationRequired: false };
    }

    const existingMethod = await this.prisma.mfaMethod.findUnique({
      where: { userId_type: { userId: user.id, type: 'TOTP' } },
    });
    if (existingMethod?.verifiedAt !== null && existingMethod !== null) {
      return { accepted: false, mfaVerificationRequired: true };
    }

    const setup = this.totp.createSetup(invitation.email);
    const method = await this.prisma.mfaMethod.upsert({
      where: { userId_type: { userId: user.id, type: 'TOTP' } },
      update: {},
      create: {
        userId: user.id,
        type: 'TOTP',
        label: 'Primary authenticator',
        secretCiphertext: this.crypto.encryptSecret(setup.secret),
      },
    });
    const secret =
      existingMethod === null ? setup.secret : this.crypto.decryptSecret(method.secretCiphertext);

    return {
      accepted: false,
      mfaVerificationRequired: true,
      provisioningUri: this.totp.provisioningUri(invitation.email, secret),
    };
  }

  async confirmMfa(token: string, code: string): Promise<ConfirmedInvitation> {
    const invitation = await this.findUsableInvitation(token);
    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: invitation.tenantId, email: invitation.email } },
      select: {
        id: true,
        mfaMethods: {
          where: { type: 'TOTP' },
          take: 1,
          select: { id: true, secretCiphertext: true, verifiedAt: true, lastUsedTimeStep: true },
        },
      },
    });
    const method = user?.mfaMethods[0];
    if (user === null || method === undefined) {
      throw this.invalidInvitation('请先设置密码并初始化多因素认证');
    }

    const timeStep = await this.totp.verifyCode(
      this.crypto.decryptSecret(method.secretCiphertext),
      code,
      method.lastUsedTimeStep,
    );
    if (timeStep === null) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'MFA_INVALID', '验证码不正确');
    }

    const recoveryCodes = method.verifiedAt === null ? this.crypto.generateRecoveryCodes() : [];
    await this.prisma.$transaction(async (database) => {
      const updated = await database.mfaMethod.updateMany({
        where: {
          id: method.id,
          OR: [{ lastUsedTimeStep: null }, { lastUsedTimeStep: { lt: timeStep } }],
        },
        data: {
          verifiedAt: method.verifiedAt ?? new Date(),
          lastUsedTimeStep: timeStep,
        },
      });
      if (updated.count !== 1) {
        throw new ApiException(HttpStatus.UNAUTHORIZED, 'MFA_INVALID', '验证码已使用');
      }
      if (recoveryCodes.length > 0) {
        await database.mfaRecoveryCode.createMany({
          data: recoveryCodes.map(({ codeHash }) => ({ mfaMethodId: method.id, codeHash })),
        });
      }
      await this.finalize(database, invitation, user.id);
    });

    return { accepted: true, recoveryCodes: recoveryCodes.map(({ code: value }) => value) };
  }

  private async finalize(
    database: Prisma.TransactionClient,
    invitation: Awaited<ReturnType<InvitationService['findUsableInvitation']>>,
    userId: string,
  ): Promise<void> {
    const now = new Date();
    if (invitation.organizationId !== null) {
      const primaryMembership = await database.organizationMembership.findFirst({
        where: { userId, isPrimary: true, status: 'ACTIVE' },
        select: { organizationId: true },
      });
      await database.organizationMembership.upsert({
        where: {
          organizationId_userId: { organizationId: invitation.organizationId, userId },
        },
        update: { status: 'ACTIVE' },
        create: {
          organizationId: invitation.organizationId,
          userId,
          isPrimary: primaryMembership === null,
        },
      });
    }

    const scopeType = invitation.organizationId === null ? 'TENANT' : 'ORGANIZATION';
    const scopeId = invitation.organizationId ?? invitation.tenantId;
    await database.roleBinding.createMany({
      data: [
        {
          tenantId: invitation.tenantId,
          roleId: invitation.initialRole.id,
          principalType: 'USER',
          principalId: userId,
          scopeType,
          scopeId,
        },
      ],
      skipDuplicates: true,
    });
    await database.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    const accepted = await database.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now, acceptedByUserId: userId },
    });
    if (accepted.count !== 1) {
      throw this.invalidInvitation('邀请已失效');
    }
    await database.auditEvent.create({
      data: {
        tenantId: invitation.tenantId,
        actorUserId: userId,
        action: 'identity.invitation.accept',
        resourceType: 'INVITATION',
        resourceId: invitation.id,
        result: 'SUCCEEDED',
      },
    });
  }

  private async findUsableInvitation(token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      include: {
        tenant: { select: { status: true, securityPolicy: true } },
        initialRole: { select: { id: true, code: true } },
      },
    });
    if (
      invitation === null ||
      invitation.tenant.status !== 'ACTIVE' ||
      invitation.initialRole === null ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null
    ) {
      throw this.invalidInvitation('邀请链接无效或已使用');
    }
    if (invitation.expiresAt <= new Date()) {
      throw new ApiException(HttpStatus.GONE, 'INVITATION_EXPIRED', '邀请已过期，请联系管理员');
    }
    if (!this.roleAllowed(invitation.type, invitation.initialRole.code)) {
      throw this.invalidInvitation('邀请角色无效');
    }
    return { ...invitation, initialRole: invitation.initialRole };
  }

  private async assertCanManageInvitations(
    actor: AuthenticatedUser,
    type: InvitationType,
    organizationId?: string,
  ): Promise<void> {
    const permissionCodes =
      type === 'TENANT_ADMIN'
        ? ['platform.manage', 'tenant.manage']
        : ['platform.manage', 'organization.users.manage'];
    const binding = await this.prisma.roleBinding.findFirst({
      where: {
        principalType: 'USER',
        principalId: actor.userId,
        role: { permissions: { some: { permission: { code: { in: permissionCodes } } } } },
        OR: [
          { scopeType: 'PLATFORM' },
          { scopeType: 'TENANT', scopeId: actor.tenantId },
          ...(organizationId === undefined
            ? []
            : [{ scopeType: 'ORGANIZATION' as const, scopeId: organizationId }]),
        ],
      },
      select: { id: true },
    });
    if (binding === null) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'ACCESS_DENIED', '无权管理该范围的邀请');
    }
  }

  private roleAllowed(type: InvitationType, roleCode: string): boolean {
    return type === 'TENANT_ADMIN'
      ? roleCode === 'platform_admin'
      : roleCode === 'organization_admin' || roleCode === 'organization_member';
  }

  private isAdministrativeRole(roleCode: string): boolean {
    return roleCode === 'platform_admin' || roleCode === 'organization_admin';
  }

  private assertMfa(actor: AuthenticatedUser): void {
    if (
      !actor.authenticationMethods.includes('totp') &&
      !actor.authenticationMethods.includes('recovery_code')
    ) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'MFA_REQUIRED', '邀请管理需要多因素认证');
    }
  }

  private invalidInvitation(message: string): ApiException {
    return new ApiException(HttpStatus.BAD_REQUEST, 'INVITATION_INVALID', message);
  }

  private resourceNotFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '公司不存在或无权访问');
  }
}
