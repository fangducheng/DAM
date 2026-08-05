import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';

import type { AuthenticatedRequest } from './authenticated-request.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().authenticatedUser;
    if (user === undefined) {
      throw new Error('CurrentUser requires AccessTokenGuard');
    }
    return user;
  },
);
