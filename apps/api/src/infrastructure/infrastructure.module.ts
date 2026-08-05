import { Global, Module } from '@nestjs/common';

import { ObjectStorageService } from './object-storage.service.js';
import { PrismaService } from './prisma.service.js';
import { RedisService } from './redis.service.js';

@Global()
@Module({
  providers: [PrismaService, RedisService, ObjectStorageService],
  exports: [PrismaService, RedisService, ObjectStorageService],
})
export class InfrastructureModule {}
