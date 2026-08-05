import { Module } from '@nestjs/common';

import { AuthorizationGuard } from './authorization.guard.js';
import { AuthorizationPolicy } from './authorization.policy.js';
import { AuthorizationService } from './authorization.service.js';

@Module({
  providers: [AuthorizationPolicy, AuthorizationService, AuthorizationGuard],
  exports: [AuthorizationPolicy, AuthorizationService, AuthorizationGuard],
})
export class AuthorizationModule {}
