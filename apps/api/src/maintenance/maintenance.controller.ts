import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationGuard } from '../authorization/authorization.guard.js';
import { RequirePermission } from '../authorization/required-permission.decorator.js';
import { requestMetadata } from '../common/http/request-metadata.js';
import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import {
  CreateStorageReconciliationRunDto,
  MaintenanceJobPageQueryDto,
  StorageReconciliationIssuePageQueryDto,
  StorageReconciliationRunPageQueryDto,
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

  @Post('storage-reconciliation/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('maintenance.manage', 'TENANT')
  @ApiOperation({ summary: 'Queue a Tenant object-storage reconciliation run' })
  createReconciliationRun(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateStorageReconciliationRunDto,
    @Req() request: FastifyRequest,
  ) {
    return this.reconciliation.createRun(actor, input, requestMetadata(request));
  }

  @Get('storage-reconciliation/runs')
  @ApiOperation({ summary: 'List Tenant object-storage reconciliation runs' })
  listReconciliationRuns(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: StorageReconciliationRunPageQueryDto,
  ) {
    return this.reconciliation.listRuns(actor, query);
  }

  @Get('storage-reconciliation/runs/:runId')
  @ApiOperation({ summary: 'Read one Tenant object-storage reconciliation run' })
  getReconciliationRun(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.reconciliation.getRun(actor, runId);
  }

  @Get('storage-reconciliation/runs/:runId/issues')
  @ApiOperation({ summary: 'List a successful reconciliation run issue snapshot' })
  listReconciliationIssues(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query() query: StorageReconciliationIssuePageQueryDto,
  ) {
    return this.reconciliation.listIssues(actor, runId, query);
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
