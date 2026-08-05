import { Injectable } from '@nestjs/common';

import type {
  ApplicableAclEntry,
  AuthorizationDecision,
  AuthorizationInput,
} from './authorization.types.js';

@Injectable()
export class AuthorizationPolicy {
  evaluate(input: AuthorizationInput): AuthorizationDecision {
    const evaluatedAt = input.evaluatedAt ?? new Date();
    const applicableAclEntries = input.aclEntries.filter(
      (entry) =>
        entry.permission === input.permission &&
        (entry.expiresAt === null || entry.expiresAt > evaluatedAt),
    );

    const deniedBy = applicableAclEntries.filter((entry) => entry.effect === 'DENY');
    if (deniedBy.length > 0) {
      return this.decision(false, 'explicit_deny', deniedBy);
    }

    const allowedBy = applicableAclEntries.filter((entry) => entry.effect === 'ALLOW');
    if (allowedBy.length > 0) {
      return this.decision(true, 'explicit_allow', allowedBy);
    }

    if (input.rolePermissions.includes(input.permission)) {
      return this.decision(true, 'role_allow', []);
    }

    return this.decision(false, 'default_deny', []);
  }

  private decision(
    allowed: boolean,
    reason: AuthorizationDecision['reason'],
    entries: readonly ApplicableAclEntry[],
  ): AuthorizationDecision {
    return {
      allowed,
      reason,
      matchedAclEntryIds: entries.map((entry) => entry.id),
    };
  }
}
