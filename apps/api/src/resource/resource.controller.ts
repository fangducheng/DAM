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
import {
  CreateFolderDto,
  NodePageQueryDto,
  NodeVersionDto,
  PurgeNodeDto,
  RecyclePageQueryDto,
  UpdateNodeDto,
} from './dto/resource.dto.js';
import { ResourceService } from './resource.service.js';

@ApiTags('resources')
@ApiBearerAuth()
@Controller()
@UseGuards(AccessTokenGuard)
export class ResourceController {
  constructor(private readonly resources: ResourceService) {}

  @Get('spaces/:spaceId/nodes')
  @ApiOperation({ summary: 'List accessible children and the current breadcrumb' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: NodePageQueryDto,
  ) {
    return this.resources.list(actor, spaceId, query);
  }

  @Post('spaces/:spaceId/folders')
  @ApiOperation({ summary: 'Create a folder under the space root or another folder' })
  createFolder(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() input: CreateFolderDto,
    @Req() request: FastifyRequest,
  ) {
    return this.resources.createFolder(actor, spaceId, input, requestMetadata(request));
  }

  @Get('spaces/:spaceId/recycle-bin')
  @ApiOperation({ summary: 'List accessible top-level deletion batches in the recycle bin' })
  recycleBin(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: RecyclePageQueryDto,
  ) {
    return this.resources.recycleBin(actor, spaceId, query);
  }

  @Get('resource-nodes/:nodeId')
  @ApiOperation({ summary: 'Read one active folder or asset' })
  get(@CurrentUser() actor: AuthenticatedUser, @Param('nodeId', ParseUUIDPipe) nodeId: string) {
    return this.resources.get(actor, nodeId);
  }

  @Patch('resource-nodes/:nodeId')
  @ApiOperation({ summary: 'Rename or move a resource with optimistic locking' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() input: UpdateNodeDto,
    @Req() request: FastifyRequest,
  ) {
    return this.resources.update(actor, nodeId, input, requestMetadata(request));
  }

  @Delete('resource-nodes/:nodeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Move a resource subtree to the recycle bin' })
  async trash(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() input: NodeVersionDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.resources.trash(actor, nodeId, input, requestMetadata(request));
  }

  @Post('resource-nodes/:nodeId/restore')
  @ApiOperation({ summary: 'Restore exactly one resource deletion batch' })
  restore(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() input: NodeVersionDto,
    @Req() request: FastifyRequest,
  ) {
    return this.resources.restore(actor, nodeId, input, requestMetadata(request));
  }

  @Post('resource-nodes/:nodeId/purge')
  @ApiOperation({ summary: 'Request irreversible deletion of one retained batch' })
  purge(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() input: PurgeNodeDto,
    @Req() request: FastifyRequest,
  ) {
    return this.resources.requestPurge(actor, nodeId, input, requestMetadata(request));
  }
}
