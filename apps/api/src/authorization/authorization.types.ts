import type { PermissionCode } from '@dam/contracts';

export type AclEffect = 'ALLOW' | 'DENY';

export interface ApplicableAclEntry {
  id: string;
  permission: PermissionCode;
  effect: AclEffect;
  resourceNodeId: string;
  depth: number;
  expiresAt: Date | null;
}

export interface AuthorizationInput {
  permission: PermissionCode;
  rolePermissions: readonly PermissionCode[];
  aclEntries: readonly ApplicableAclEntry[];
  evaluatedAt?: Date;
}

export type AuthorizationReason =
  'explicit_deny' | 'explicit_allow' | 'role_allow' | 'default_deny';

export interface AuthorizationDecision {
  allowed: boolean;
  reason: AuthorizationReason;
  matchedAclEntryIds: string[];
}

export type AuthorizationScope =
  | { type: 'TENANT'; id: string }
  | { type: 'ORGANIZATION'; id: string }
  | { type: 'SPACE'; id: string }
  | { type: 'NODE'; id: string };

export type AuthorizationScopeKind = AuthorizationScope['type'];

export interface AuthorizationRequestMetadata {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuthorizationExplanation extends AuthorizationDecision {
  permission: PermissionCode;
  scope: AuthorizationScope;
  authorizationVersion: string;
  roleCodes: string[];
  matchedAclEntries: Array<{
    id: string;
    effect: AclEffect;
    resourceNodeId: string;
    depth: number;
  }>;
}

export interface ResolvedPrincipal {
  type: 'USER' | 'GROUP' | 'ORGANIZATION';
  id: string;
}

export interface CachedRoleBinding {
  scopeType: 'PLATFORM' | 'TENANT' | 'ORGANIZATION' | 'SPACE';
  scopeId: string | null;
  roleCode: string;
  permissions: PermissionCode[];
  expiresAt: string | null;
}

export interface AuthorizationSubject {
  authorizationVersion: string;
  principals: ResolvedPrincipal[];
  roleBindings: CachedRoleBinding[];
}
