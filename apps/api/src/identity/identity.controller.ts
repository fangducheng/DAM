import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedUser } from '@dam/contracts';

import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiException } from '../common/errors/api.exception.js';
import { AccessTokenGuard } from './auth/access-token.guard.js';
import { CurrentUser } from './auth/current-user.decorator.js';
import { MfaGuard } from './auth/mfa.guard.js';
import {
  AcceptInvitationDto,
  CompleteMfaDto,
  ConfirmInvitationMfaDto,
  CreateInvitationDto,
  LoginDto,
} from './dto/identity.dto.js';
import { IdentityService } from './identity.service.js';
import type { IdentityRequestMetadata, IssuedSession } from './identity.types.js';
import { InvitationService } from './invitation.service.js';

interface CookieRequest extends FastifyRequest {
  cookies: Record<string, string | undefined>;
}

interface CookieReply extends FastifyReply {
  setCookie(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'lax';
      path: string;
      maxAge: number;
    },
  ): FastifyReply;
  clearCookie(name: string, options: { path: string }): FastifyReply;
}

@ApiTags('identity')
@Controller('identity')
export class IdentityController {
  private readonly cookieName: string;
  private readonly secureCookie: boolean;

  constructor(
    private readonly identity: IdentityService,
    private readonly invitations: InvitationService,
    private readonly authorization: AuthorizationService,
    config: ConfigService,
  ) {
    this.cookieName = config.getOrThrow<string>('REFRESH_COOKIE_NAME');
    this.secureCookie = config.getOrThrow<boolean>('COOKIE_SECURE');
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Authenticate with Tenant, account, and password' })
  async login(
    @Body() input: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<unknown> {
    const result = await this.identity.login(input, this.metadata(request));
    return 'mfaRequired' in result ? result : this.respondWithSession(reply, result);
  }

  @Post('login/mfa')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Complete a password login with TOTP or a recovery code' })
  async completeMfa(
    @Body() input: CompleteMfaDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<unknown> {
    const result = await this.identity.completeMfa(
      input.challengeToken,
      input.code,
      this.metadata(request),
    );
    return this.respondWithSession(reply, result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Rotate the Refresh Token and issue a new Access Token' })
  async refresh(
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<unknown> {
    const refreshToken = request.cookies[this.cookieName];
    if (refreshToken === undefined) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'SESSION_EXPIRED',
        '登录状态已失效，请重新登录',
      );
    }
    const result = await this.identity.refresh(refreshToken, this.metadata(request));
    return this.respondWithSession(reply, result);
  }

  @Get('capabilities')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Read effective Tenant capabilities for the current user' })
  capabilities(@CurrentUser() user: AuthenticatedUser) {
    return this.authorization.tenantCapabilities(user);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current session' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<void> {
    await this.identity.logout(user, this.metadata(request));
    this.clearRefreshCookie(reply);
  }

  @Get('sessions')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions for the current user' })
  sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.listSessions(user);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one session owned by the current user' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.identity.revokeSession(user, sessionId, this.metadata(request));
  }

  @Delete('sessions')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke all sessions owned by the current user' })
  async revokeAllSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<{ revokedSessions: number }> {
    const revokedSessions = await this.identity.revokeAllSessions(user, this.metadata(request));
    this.clearRefreshCookie(reply);
    return { revokedSessions };
  }

  @Post('invitations')
  @UseGuards(AccessTokenGuard, MfaGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a one-time Tenant or organization invitation' })
  createInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateInvitationDto,
    @Req() request: FastifyRequest,
  ) {
    return this.invitations.create(user, input, this.metadata(request));
  }

  @Delete('invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard, MfaGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke an unused invitation' })
  async revokeInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.invitations.revoke(user, invitationId, this.metadata(request));
  }

  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Set credentials and accept an invitation' })
  acceptInvitation(@Body() input: AcceptInvitationDto) {
    return this.invitations.accept(input.token, input.password);
  }

  @Post('invitations/confirm-mfa')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: 'Verify TOTP and finish accepting an invitation' })
  confirmInvitationMfa(@Body() input: ConfirmInvitationMfaDto) {
    return this.invitations.confirmMfa(input.token, input.code);
  }

  private respondWithSession(reply: CookieReply, session: IssuedSession): Record<string, unknown> {
    reply.setCookie(this.cookieName, session.refreshToken, {
      httpOnly: true,
      secure: this.secureCookie,
      sameSite: 'lax',
      path: '/api/v1/identity',
      maxAge: session.refreshTokenExpiresInSeconds,
    });
    return {
      accessToken: session.accessToken,
      accessTokenExpiresInSeconds: session.accessTokenExpiresInSeconds,
      user: session.user,
    };
  }

  private clearRefreshCookie(reply: CookieReply): void {
    reply.clearCookie(this.cookieName, { path: '/api/v1/identity' });
  }

  private metadata(request: FastifyRequest): IdentityRequestMetadata {
    const userAgent = request.headers['user-agent'];
    return {
      ipAddress: request.ip,
      requestId: String(request.id),
      ...(userAgent === undefined ? {} : { userAgent }),
    };
  }
}
