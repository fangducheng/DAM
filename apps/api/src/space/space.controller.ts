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
  CreateSpaceDto,
  SpaceMemberPageQueryDto,
  SpaceMemberRouteParamsDto,
  SpacePageQueryDto,
  UpdateSpaceDto,
  UpsertSpaceMemberDto,
} from './dto/space.dto.js';
import { SpaceMemberService } from './space-member.service.js';
import { SpaceService } from './space.service.js';

@ApiTags('spaces')
@ApiBearerAuth()
@Controller('spaces')
@UseGuards(AccessTokenGuard)
export class SpaceController {
  constructor(
    private readonly spaces: SpaceService,
    private readonly members: SpaceMemberService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List spaces visible to the current user' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: SpacePageQueryDto) {
    return this.spaces.list(actor, query);
  }

  @Post()
  @UseGuards(MfaGuard)
  @ApiOperation({ summary: 'Create a Tenant-owned or organization-owned space' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateSpaceDto,
    @Req() request: FastifyRequest,
  ) {
    return this.spaces.create(actor, input, requestMetadata(request));
  }

  @Get(':spaceId')
  @ApiOperation({ summary: 'Read one accessible space' })
  get(@CurrentUser() actor: AuthenticatedUser, @Param('spaceId', ParseUUIDPipe) spaceId: string) {
    return this.spaces.get(actor, spaceId);
  }

  @Patch(':spaceId')
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('space.manage', 'SPACE')
  @ApiOperation({ summary: 'Update a space' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() input: UpdateSpaceDto,
    @Req() request: FastifyRequest,
  ) {
    return this.spaces.update(actor, spaceId, input, requestMetadata(request));
  }

  @Get(':spaceId/members')
  @UseGuards(AuthorizationGuard)
  @RequirePermission('space.members.manage', 'SPACE')
  @ApiOperation({ summary: 'List direct users, groups, and organizations in a space' })
  listMembers(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: SpaceMemberPageQueryDto,
  ) {
    return this.members.list(actor, spaceId, query);
  }

  @Put(':spaceId/members/:principalType/:principalId')
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('space.members.manage', 'SPACE')
  @ApiOperation({ summary: 'Create or update a direct space membership' })
  upsertMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: SpaceMemberRouteParamsDto,
    @Body() input: UpsertSpaceMemberDto,
    @Req() request: FastifyRequest,
  ) {
    return this.members.upsert(actor, params.spaceId, params, input, requestMetadata(request));
  }

  @Delete(':spaceId/members/:principalType/:principalId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(MfaGuard, AuthorizationGuard)
  @RequirePermission('space.members.manage', 'SPACE')
  @ApiOperation({ summary: 'Remove a direct space membership and its dormant ACL entries' })
  async removeMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: SpaceMemberRouteParamsDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.members.remove(actor, params.spaceId, params, requestMetadata(request));
  }
}
