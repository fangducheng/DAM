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
