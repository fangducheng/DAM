import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationGuard } from '../authorization/authorization.guard.js';
import { RequirePermission } from '../authorization/required-permission.decorator.js';
import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import { AuditService } from './audit.service.js';
import { AuditPageQueryDto } from './dto/discovery.dto.js';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-events')
@UseGuards(AccessTokenGuard, AuthorizationGuard)
@RequirePermission('audit.read', 'TENANT')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Browse filtered Tenant audit events' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: AuditPageQueryDto) {
    return this.audit.list(actor, query);
  }
}
