import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { TagController } from './tag.controller.js';
import { TagService } from './tag.service.js';

@Module({
  imports: [IdentityModule, AuthorizationModule],
  controllers: [TagController, SearchController, AuditController, NotificationController],
  providers: [TagService, SearchService, AuditService, NotificationService],
})
export class DiscoveryModule {}
