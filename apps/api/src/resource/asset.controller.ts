import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedUser } from '@dam/contracts';

import { requestMetadata } from '../common/http/request-metadata.js';
import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import { AssetService } from './asset.service.js';
import { SetCurrentVersionDto } from './dto/resource.dto.js';

@ApiTags('assets')
@ApiBearerAuth()
@Controller()
@UseGuards(AccessTokenGuard)
export class AssetController {
  constructor(private readonly assets: AssetService) {}

  @Get('assets/:assetId/versions')
  @ApiOperation({ summary: 'List immutable versions of one asset' })
  versions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.assets.versions(actor, assetId);
  }

  @Put('assets/:assetId/current-version')
  @ApiOperation({ summary: 'Select one available immutable version as current' })
  setCurrentVersion(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() input: SetCurrentVersionDto,
    @Req() request: FastifyRequest,
  ) {
    return this.assets.setCurrentVersion(actor, assetId, input.versionId, requestMetadata(request));
  }

  @Get('resource-nodes/:nodeId/preview')
  @ApiOperation({ summary: 'Issue an authorized short-lived inline preview URL' })
  preview(@CurrentUser() actor: AuthenticatedUser, @Param('nodeId', ParseUUIDPipe) nodeId: string) {
    return this.assets.nodeUrl(actor, nodeId, 'preview');
  }

  @Get('resource-nodes/:nodeId/download')
  @ApiOperation({ summary: 'Issue an authorized short-lived download URL' })
  download(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ) {
    return this.assets.nodeUrl(actor, nodeId, 'download');
  }

  @Get('asset-versions/:versionId/download')
  @ApiOperation({ summary: 'Issue an authorized URL for one historical version' })
  versionDownload(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.assets.versionDownload(actor, versionId);
  }
}
