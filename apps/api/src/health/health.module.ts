import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { ObjectStorageService } from '../infrastructure/object-storage.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { RedisService } from '../infrastructure/redis.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService, PrismaService, RedisService, ObjectStorageService],
})
export class HealthModule {}
