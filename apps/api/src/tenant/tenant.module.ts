import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { GroupController } from './group.controller.js';
import { GroupService } from './group.service.js';
import { OrganizationController } from './organization.controller.js';
import { OrganizationService } from './organization.service.js';
import { TenantController } from './tenant.controller.js';
import { TenantService } from './tenant.service.js';

@Module({
  imports: [IdentityModule, AuthorizationModule],
  controllers: [TenantController, OrganizationController, GroupController],
  providers: [TenantService, OrganizationService, GroupService],
})
export class TenantModule {}
