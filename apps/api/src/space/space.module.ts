import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AclController } from './acl.controller.js';
import { AclService } from './acl.service.js';
import { SpaceMemberService } from './space-member.service.js';
import { SpaceController } from './space.controller.js';
import { SpaceService } from './space.service.js';

@Module({
  imports: [IdentityModule, AuthorizationModule],
  controllers: [SpaceController, AclController],
  providers: [SpaceService, SpaceMemberService, AclService],
})
export class SpaceModule {}
