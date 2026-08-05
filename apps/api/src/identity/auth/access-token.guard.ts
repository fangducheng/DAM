import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';

import { ApiException } from '../../common/errors/api.exception.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';
import { IdentityTokenService } from '../security/identity-token.service.js';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly tokens: IdentityTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

    if (token === undefined || token.length === 0) {
      throw this.sessionExpired();
    }

    try {
      const claims = await this.tokens.verifyAccessToken(token);
      const session = await this.prisma.authSession.findUnique({
        where: { id: claims.sessionId },
        select: {
          userId: true,
          authenticatedAt: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: { tenantId: true, status: true } },
        },
      });

      if (
        session === null ||
        session.userId !== claims.sub ||
        session.user.tenantId !== claims.tenantId ||
        session.user.status !== 'ACTIVE' ||
        session.authenticatedAt === null ||
        session.revokedAt !== null ||
        session.expiresAt <= new Date()
      ) {
        throw this.sessionExpired();
      }

      request.authenticatedUser = {
        userId: claims.sub,
        tenantId: claims.tenantId,
        sessionId: claims.sessionId,
        authenticationMethods: claims.amr,
      };
      return true;
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }
      throw this.sessionExpired();
    }
  }

  private sessionExpired(): ApiException {
    return new ApiException(
      HttpStatus.UNAUTHORIZED,
      'SESSION_EXPIRED',
      '登录状态已失效，请重新登录',
    );
  }
}
