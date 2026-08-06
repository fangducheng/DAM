import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AssetController } from './asset.controller.js';
import { AssetService } from './asset.service.js';
import { ResourceController } from './resource.controller.js';
import { ResourceService } from './resource.service.js';
import { UploadController } from './upload.controller.js';
import { UploadService } from './upload.service.js';

@Module({
  imports: [IdentityModule, AuthorizationModule],
  controllers: [ResourceController, UploadController, AssetController],
  providers: [ResourceService, UploadService, AssetService],
})
export class ResourceModule {}
