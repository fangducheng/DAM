import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationGuard } from '../authorization/authorization.guard.js';
import { RequirePermission } from '../authorization/required-permission.decorator.js';
import { requestMetadata } from '../common/http/request-metadata.js';
import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import {
  MaintenanceJobPageQueryDto,
  StorageReconciliationPageQueryDto,
} from './dto/maintenance.dto.js';
import { MaintenanceService } from './maintenance.service.js';
import { StorageReconciliationService } from './storage-reconciliation.service.js';

@ApiTags('maintenance')
@ApiBearerAuth()
@Controller('maintenance')
@UseGuards(AccessTokenGuard, AuthorizationGuard)
@RequirePermission('maintenance.read', 'TENANT')
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly reconciliation: StorageReconciliationService,
  ) {}

  @Get('summary')
  @ApiOperation({ summary: 'Read Tenant lifecycle maintenance counts' })
  summary(@CurrentUser() actor: AuthenticatedUser) {
    return this.maintenance.summary(actor);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List safe Tenant maintenance job details' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: MaintenanceJobPageQueryDto) {
    return this.maintenance.list(actor, query);
  }

  @Get('storage-reconciliation')
  @ApiOperation({ summary: 'Generate a safe Tenant object-storage reconciliation report' })
  reconcileStorage(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: StorageReconciliationPageQueryDto,
    @Req() request: FastifyRequest,
  ) {
    return this.reconciliation.report(actor, query, requestMetadata(request));
  }

  @Post('jobs/:jobId/retry')
  @RequirePermission('maintenance.manage', 'TENANT')
  @ApiOperation({ summary: 'Retry one terminal maintenance job' })
  retry(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.maintenance.retry(actor, jobId, requestMetadata(request));
  }
}
