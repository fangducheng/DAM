import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
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
import { CreateUploadSessionDto, RecordUploadPartDto } from './dto/resource.dto.js';
import { UploadService } from './upload.service.js';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller()
@UseGuards(AccessTokenGuard)
export class UploadController {
  constructor(private readonly uploads: UploadService) {}

  @Post('spaces/:spaceId/upload-sessions')
  @ApiOperation({ summary: 'Reserve quota and initiate a resumable S3 multipart upload' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() input: CreateUploadSessionDto,
    @Req() request: FastifyRequest,
  ) {
    return this.uploads.create(actor, spaceId, input, requestMetadata(request));
  }

  @Get('upload-sessions/:sessionId')
  @ApiOperation({ summary: 'Read an upload session and its recorded parts' })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.uploads.get(actor, sessionId);
  }

  @Get('upload-sessions/:sessionId/parts/:partNumber/url')
  @ApiOperation({ summary: 'Issue a short-lived URL for one multipart upload part' })
  partUrl(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
  ) {
    return this.uploads.partUrl(actor, sessionId, partNumber);
  }

  @Put('upload-sessions/:sessionId/parts/:partNumber')
  @ApiOperation({ summary: 'Record a successfully uploaded part ETag and size' })
  recordPart(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Body() input: RecordUploadPartDto,
  ) {
    return this.uploads.recordPart(actor, sessionId, partNumber, input);
  }

  @Post('upload-sessions/:sessionId/complete')
  @ApiOperation({ summary: 'Complete, verify, and commit an uploaded asset version' })
  complete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.uploads.complete(actor, sessionId, requestMetadata(request));
  }

  @Delete('upload-sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Abort an active multipart upload' })
  async abort(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<void> {
    await this.uploads.abort(actor, sessionId);
  }
}
