import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../identity/auth/authenticated-request.js';
import { AuthorizationService } from './authorization.service.js';
import { REQUIRED_PERMISSION, type RequiredPermission } from './required-permission.decorator.js';

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(REQUIRED_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = request.authenticatedUser;
    if (actor === undefined) {
      return false;
    }

    const id =
      required.scope === 'TENANT'
        ? actor.tenantId
        : this.parameter(request, required.parameter ?? this.defaultParameter(required.scope));
    await this.authorization.assert(
      actor,
      required.permission,
      { type: required.scope, id },
      {
        ipAddress: request.ip,
        requestId: String(request.id),
        ...(request.headers['user-agent'] === undefined
          ? {}
          : { userAgent: request.headers['user-agent'] }),
      },
    );
    return true;
  }

  private parameter(request: FastifyRequest, name: string): string {
    const parameters = request.params as Record<string, unknown>;
    const value = parameters[name];
    return typeof value === 'string' ? value : '';
  }

  private defaultParameter(scope: RequiredPermission['scope']): string {
    switch (scope) {
      case 'ORGANIZATION':
        return 'organizationId';
      case 'SPACE':
        return 'spaceId';
      case 'NODE':
        return 'nodeId';
      case 'TENANT':
        return 'tenantId';
    }
  }
}
