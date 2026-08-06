import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { AclService } from './acl.service.js';
import {
  AclListQueryDto,
  PermissionRouteParamsDto,
  UpsertResourceAclDto,
} from './dto/space.dto.js';

@ApiTags('resource permissions')
@ApiBearerAuth()
@Controller('resource-nodes')
@UseGuards(AccessTokenGuard)
export class AclController {
  constructor(private readonly acl: AclService) {}

  @Get(':nodeId/acl')
  @UseGuards(AuthorizationGuard)
  @RequirePermission('node.permissions.manage', 'NODE')
  @ApiOperation({ summary: 'List direct and inherited ACL entries for a resource node' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Query() query: AclListQueryDto,
  ) {
    return this.acl.list(actor, nodeId, query);
  }

  @Put(':nodeId/acl')
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('node.permissions.manage', 'NODE')
  @ApiOperation({ summary: 'Create or replace one direct ACL entry' })
  upsert(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() input: UpsertResourceAclDto,
    @Req() request: FastifyRequest,
  ) {
    return this.acl.upsert(actor, nodeId, input, requestMetadata(request));
  }

  @Delete(':nodeId/acl/:aclEntryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('node.permissions.manage', 'NODE')
  @ApiOperation({ summary: 'Delete one direct ACL entry' })
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Param('aclEntryId', ParseUUIDPipe) aclEntryId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.acl.remove(actor, nodeId, aclEntryId, requestMetadata(request));
  }

  @Get(':nodeId/permissions/:permissionCode')
  @ApiOperation({ summary: 'Explain one current-user permission without exposing hidden nodes' })
  explain(@CurrentUser() actor: AuthenticatedUser, @Param() params: PermissionRouteParamsDto) {
    return this.acl.explain(actor, params.nodeId, params.permissionCode);
  }
}
