import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { MfaGuard } from '../identity/auth/mfa.guard.js';
import {
  CreateOrganizationDto,
  PageQueryDto,
  UpdateOrganizationDto,
  UpsertOrganizationMembershipDto,
} from './dto/tenant.dto.js';
import { OrganizationService } from './organization.service.js';

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
@UseGuards(AccessTokenGuard)
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get()
  @ApiOperation({ summary: 'List organizations visible to the current user' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: PageQueryDto) {
    return this.organizations.list(actor, query);
  }

  @Post()
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('tenant.manage', 'TENANT')
  @ApiOperation({ summary: 'Create an organization in the current Tenant' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateOrganizationDto,
    @Req() request: FastifyRequest,
  ) {
    return this.organizations.create(actor, input, requestMetadata(request));
  }

  @Get(':organizationId')
  @ApiOperation({ summary: 'Read one visible organization' })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.organizations.get(actor, organizationId);
  }

  @Patch(':organizationId')
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('organization.manage', 'ORGANIZATION')
  @ApiOperation({ summary: 'Update organization metadata, hierarchy, or status' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() input: UpdateOrganizationDto,
    @Req() request: FastifyRequest,
  ) {
    return this.organizations.update(actor, organizationId, input, requestMetadata(request));
  }

  @Get(':organizationId/members')
  @UseGuards(AuthorizationGuard)
  @RequirePermission('organization.users.manage', 'ORGANIZATION')
  @ApiOperation({ summary: 'List organization memberships and company roles' })
  members(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: PageQueryDto,
  ) {
    return this.organizations.listMembers(actor, organizationId, query);
  }

  @Put(':organizationId/members/:userId')
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('organization.users.manage', 'ORGANIZATION')
  @ApiOperation({ summary: 'Create or update an organization membership and role' })
  upsertMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() input: UpsertOrganizationMembershipDto,
    @Req() request: FastifyRequest,
  ) {
    return this.organizations.upsertMember(
      actor,
      organizationId,
      userId,
      input,
      requestMetadata(request),
    );
  }

  @Delete(':organizationId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('organization.users.manage', 'ORGANIZATION')
  @ApiOperation({ summary: 'Disable an organization membership and its company role' })
  async removeMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.organizations.removeMember(actor, organizationId, userId, requestMetadata(request));
  }
}
