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

import { requestMetadata } from '../common/http/request-metadata.js';
import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import { MfaGuard } from '../identity/auth/mfa.guard.js';
import { CreateGroupDto, PageQueryDto, UpdateGroupDto } from './dto/tenant.dto.js';
import { GroupService } from './group.service.js';

@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
@UseGuards(AccessTokenGuard)
export class GroupController {
  constructor(private readonly groups: GroupService) {}

  @Get()
  @ApiOperation({ summary: 'List shared and organization groups visible to the current user' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: PageQueryDto) {
    return this.groups.list(actor, query);
  }

  @Post()
  @UseGuards(MfaGuard)
  @ApiOperation({ summary: 'Create a Tenant shared group or organization group' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateGroupDto,
    @Req() request: FastifyRequest,
  ) {
    return this.groups.create(actor, input, requestMetadata(request));
  }

  @Patch(':groupId')
  @UseGuards(MfaGuard)
  @ApiOperation({ summary: 'Update or disable a group' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() input: UpdateGroupDto,
    @Req() request: FastifyRequest,
  ) {
    return this.groups.update(actor, groupId, input, requestMetadata(request));
  }

  @Get(':groupId/members')
  @ApiOperation({ summary: 'List members of a manageable group' })
  members(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Query() query: PageQueryDto,
    @Req() request: FastifyRequest,
  ) {
    return this.groups.listMembers(actor, groupId, query, requestMetadata(request));
  }

  @Put(':groupId/members/:userId')
  @UseGuards(MfaGuard)
  @ApiOperation({ summary: 'Add a user to a manageable group' })
  addMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.groups.addMember(actor, groupId, userId, requestMetadata(request));
  }

  @Delete(':groupId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(MfaGuard)
  @ApiOperation({ summary: 'Remove a user from a manageable group' })
  async removeMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.groups.removeMember(actor, groupId, userId, requestMetadata(request));
  }
}
