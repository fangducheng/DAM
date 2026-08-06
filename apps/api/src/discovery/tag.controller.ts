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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedUser } from '@dam/contracts';

import { requestMetadata } from '../common/http/request-metadata.js';
import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import { AssignAssetTagsDto, CreateTagDto, UpdateTagDto } from './dto/discovery.dto.js';
import { TagService } from './tag.service.js';

@ApiTags('tags')
@ApiBearerAuth()
@Controller()
@UseGuards(AccessTokenGuard)
export class TagController {
  constructor(private readonly tags: TagService) {}

  @Get('spaces/:spaceId/tags')
  @ApiOperation({ summary: 'List the tag vocabulary for an accessible space' })
  list(@CurrentUser() actor: AuthenticatedUser, @Param('spaceId', ParseUUIDPipe) spaceId: string) {
    return this.tags.list(actor, spaceId);
  }

  @Post('spaces/:spaceId/tags')
  @ApiOperation({ summary: 'Create a space tag' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() input: CreateTagDto,
    @Req() request: FastifyRequest,
  ) {
    return this.tags.create(actor, spaceId, input, requestMetadata(request));
  }

  @Patch('spaces/:spaceId/tags/:tagId')
  @ApiOperation({ summary: 'Update a space tag' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Body() input: UpdateTagDto,
    @Req() request: FastifyRequest,
  ) {
    return this.tags.update(actor, spaceId, tagId, input, requestMetadata(request));
  }

  @Delete('spaces/:spaceId/tags/:tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a space tag and its asset assignments' })
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.tags.remove(actor, spaceId, tagId, requestMetadata(request));
  }

  @Get('assets/:assetId/tags')
  @ApiOperation({ summary: 'List tags assigned to an asset' })
  assetTags(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.tags.assetTags(actor, assetId);
  }

  @Put('assets/:assetId/tags')
  @ApiOperation({ summary: 'Replace the tags assigned to an asset' })
  assign(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() input: AssignAssetTagsDto,
    @Req() request: FastifyRequest,
  ) {
    return this.tags.assign(actor, assetId, input, requestMetadata(request));
  }
}
