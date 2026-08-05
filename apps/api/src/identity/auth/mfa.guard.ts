import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';

import { ApiException } from '../../common/errors/api.exception.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

@Injectable()
export class MfaGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const methods = request.authenticatedUser?.authenticationMethods ?? [];

    if (!methods.includes('totp') && !methods.includes('recovery_code')) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'MFA_REQUIRED', '此操作需要多因素认证');
    }

    return true;
  }
}
