import { SetMetadata } from '@nestjs/common';

import type { PermissionCode } from '@dam/contracts';

import type { AuthorizationScopeKind } from './authorization.types.js';

export const REQUIRED_PERMISSION = 'dam.required-permission';

export interface RequiredPermission {
  permission: PermissionCode;
  scope: AuthorizationScopeKind;
  parameter?: string;
}

export function RequirePermission(
  permission: PermissionCode,
  scope: AuthorizationScopeKind,
  parameter?: string,
): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRED_PERMISSION, {
    permission,
    scope,
    ...(parameter === undefined ? {} : { parameter }),
  } satisfies RequiredPermission);
}
