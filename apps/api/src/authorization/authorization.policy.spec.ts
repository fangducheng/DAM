import { describe, expect, it } from 'vitest';

import type { PermissionCode } from '@dam/contracts';

import { AuthorizationPolicy } from './authorization.policy.js';
import type { ApplicableAclEntry, AuthorizationInput } from './authorization.types.js';

const evaluatedAt = new Date('2026-08-05T00:00:00.000Z');

function acl(
  id: string,
  effect: ApplicableAclEntry['effect'],
  permission: PermissionCode = 'node.download',
  expiresAt: Date | null = null,
  depth = 0,
): ApplicableAclEntry {
  return {
    id,
    permission,
    effect,
    resourceNodeId: `node-${id}`,
    depth,
    expiresAt,
  };
}

function input(overrides: Partial<AuthorizationInput> = {}): AuthorizationInput {
  return {
    permission: 'node.download',
    rolePermissions: [],
    aclEntries: [],
    evaluatedAt,
    ...overrides,
  };
}

describe('AuthorizationPolicy', () => {
  const policy = new AuthorizationPolicy();

  it('allows a permission granted by the space role', () => {
    expect(policy.evaluate(input({ rolePermissions: ['node.view', 'node.download'] }))).toEqual({
      allowed: true,
      reason: 'role_allow',
      matchedAclEntryIds: [],
    });
  });

  it('denies by default when no role or ACL grants the permission', () => {
    expect(policy.evaluate(input())).toEqual({
      allowed: false,
      reason: 'default_deny',
      matchedAclEntryIds: [],
    });
  });

  it('allows a Restricted member through an explicit folder ACL', () => {
    expect(
      policy.evaluate(input({ aclEntries: [acl('folder-allow', 'ALLOW', undefined, null, 2)] })),
    ).toEqual({
      allowed: true,
      reason: 'explicit_allow',
      matchedAclEntryIds: ['folder-allow'],
    });
  });

  it('lets an explicit deny override a role grant', () => {
    expect(
      policy.evaluate(
        input({
          rolePermissions: ['node.download'],
          aclEntries: [acl('sensitive-contract', 'DENY')],
        }),
      ),
    ).toEqual({
      allowed: false,
      reason: 'explicit_deny',
      matchedAclEntryIds: ['sensitive-contract'],
    });
  });

  it('lets an inherited deny override a direct allow', () => {
    expect(
      policy.evaluate(
        input({
          aclEntries: [
            acl('direct-allow', 'ALLOW', undefined, null, 0),
            acl('parent-deny', 'DENY', undefined, null, 3),
          ],
        }),
      ),
    ).toEqual({
      allowed: false,
      reason: 'explicit_deny',
      matchedAclEntryIds: ['parent-deny'],
    });
  });

  it('ignores an expired deny and falls back to the role grant', () => {
    expect(
      policy.evaluate(
        input({
          rolePermissions: ['node.download'],
          aclEntries: [acl('expired-deny', 'DENY', undefined, new Date('2026-08-04'))],
        }),
      ),
    ).toEqual({ allowed: true, reason: 'role_allow', matchedAclEntryIds: [] });
  });

  it('ignores an expired allow', () => {
    expect(
      policy.evaluate(
        input({
          aclEntries: [acl('expired-allow', 'ALLOW', undefined, new Date('2026-08-04'))],
        }),
      ),
    ).toEqual({
      allowed: false,
      reason: 'default_deny',
      matchedAclEntryIds: [],
    });
  });

  it('ignores ACL entries for another permission', () => {
    expect(
      policy.evaluate(input({ aclEntries: [acl('preview-allow', 'ALLOW', 'node.preview')] })),
    ).toEqual({
      allowed: false,
      reason: 'default_deny',
      matchedAclEntryIds: [],
    });
  });
});
