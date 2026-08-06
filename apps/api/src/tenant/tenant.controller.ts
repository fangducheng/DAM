import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationGuard } from '../authorization/authorization.guard.js';
import { RequirePermission } from '../authorization/required-permission.decorator.js';
import { requestMetadata } from '../common/http/request-metadata.js';
import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import { MfaGuard } from '../identity/auth/mfa.guard.js';
import { UpdateTenantSecurityPolicyDto } from './dto/tenant.dto.js';
import { TenantService } from './tenant.service.js';

@ApiTags('tenant')
@ApiBearerAuth()
@Controller('tenant')
@UseGuards(AccessTokenGuard)
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  @Get('current')
  @ApiOperation({ summary: 'Read the current Tenant and its security policy' })
  current(@CurrentUser() actor: AuthenticatedUser) {
    return this.tenants.current(actor);
  }

  @Patch('current/security-policy')
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('tenant.manage', 'TENANT')
  @ApiOperation({ summary: 'Update the current Tenant security policy' })
  updateSecurityPolicy(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: UpdateTenantSecurityPolicyDto,
    @Req() request: FastifyRequest,
  ) {
    return this.tenants.updateSecurityPolicy(actor, input, requestMetadata(request));
  }
}
