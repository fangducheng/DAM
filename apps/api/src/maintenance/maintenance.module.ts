import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';
import { StorageReconciliationService } from './storage-reconciliation.service.js';

@Module({
  imports: [IdentityModule, AuthorizationModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService, StorageReconciliationService],
})
export class MaintenanceModule {}
