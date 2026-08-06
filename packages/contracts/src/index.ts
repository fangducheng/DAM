export const dependencyNames = ['database', 'redis', 'objectStorage'] as const;

export type DependencyName = (typeof dependencyNames)[number];
export type HealthState = 'up' | 'down';

export interface DependencyHealth {
  name: DependencyName;
  status: HealthState;
  latencyMs: number;
  detail?: string;
}

export interface LivenessResponse {
  status: 'ok';
  service: 'dam-api';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessResponse {
  status: 'ready' | 'degraded';
  service: 'dam-api';
  version: string;
  timestamp: string;
  dependencies: DependencyHealth[];
}

export const permissionCodes = [
  'platform.manage',
  'audit.read',
  'maintenance.read',
  'maintenance.manage',
  'tenant.manage',
  'organization.manage',
  'organization.users.manage',
  'space.create',
  'space.manage',
  'space.members.manage',
  'node.view',
  'node.preview',
  'node.download',
  'node.create',
  'node.update',
  'node.delete',
  'node.permissions.manage',
] as const;

export type PermissionCode = (typeof permissionCodes)[number];

export const systemRoleCodes = [
  'platform_admin',
  'platform_auditor',
  'organization_admin',
  'organization_member',
  'space_manager',
  'editor',
  'contributor',
  'viewer',
  'restricted',
] as const;

export type SystemRoleCode = (typeof systemRoleCodes)[number];

export const systemRolePermissions = {
  platform_admin: permissionCodes,
  platform_auditor: ['audit.read', 'maintenance.read'],
  organization_admin: ['organization.manage', 'organization.users.manage', 'space.create'],
  organization_member: [],
  space_manager: [
    'space.manage',
    'space.members.manage',
    'node.view',
    'node.preview',
    'node.download',
    'node.create',
    'node.update',
    'node.delete',
    'node.permissions.manage',
  ],
  editor: ['node.view', 'node.preview', 'node.download', 'node.create', 'node.update'],
  contributor: ['node.view', 'node.preview', 'node.download', 'node.create', 'node.update'],
  viewer: ['node.view', 'node.preview', 'node.download'],
  restricted: [],
} as const satisfies Record<SystemRoleCode, readonly PermissionCode[]>;

export const apiErrorCodes = [
  'VALIDATION_FAILED',
  'AUTHENTICATION_FAILED',
  'SESSION_EXPIRED',
  'MFA_REQUIRED',
  'MFA_INVALID',
  'ACCESS_DENIED',
  'RESOURCE_NOT_FOUND',
  'VERSION_CONFLICT',
  'INVITATION_INVALID',
  'INVITATION_EXPIRED',
  'TOO_MANY_ATTEMPTS',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

export interface ApiFieldError {
  field: string;
  code: string;
  message: string;
}

export interface ApiErrorResponse {
  statusCode: number;
  code: ApiErrorCode;
  message: string;
  requestId: string;
  timestamp: string;
  fieldErrors?: ApiFieldError[];
}

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  sessionId: string;
  authenticationMethods: readonly ('password' | 'totp' | 'recovery_code')[];
}
