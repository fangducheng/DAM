import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { validateEnvironment } from '@dam/config';

import { ObjectStorageService } from './infrastructure/object-storage.service.js';
import { PrismaService } from './infrastructure/prisma.service.js';
import { MaintenanceProcessorService } from './maintenance/maintenance-processor.service.js';
import { MaintenanceQueueService } from './maintenance/maintenance-queue.service.js';
import { MaintenanceSchedulerService } from './maintenance/maintenance-scheduler.service.js';
import { StorageReconciliationProcessorService } from './maintenance/storage-reconciliation-processor.service.js';
import { AssetProcessingService } from './processing/asset-processing.service.js';
import { ClamAvService } from './processing/clamav.service.js';
import { ContentExtractionService } from './processing/content-extraction.service.js';
import { ProcessingQueueService } from './processing/processing-queue.service.js';
import { WorkerRuntimeService } from './worker-runtime.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
      validate: validateEnvironment,
      cache: true,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', 'info'),
        },
      }),
    }),
  ],
  providers: [
    PrismaService,
    ObjectStorageService,
    ProcessingQueueService,
    ClamAvService,
    ContentExtractionService,
    AssetProcessingService,
    MaintenanceQueueService,
    StorageReconciliationProcessorService,
    MaintenanceProcessorService,
    MaintenanceSchedulerService,
    WorkerRuntimeService,
  ],
})
export class WorkerModule {}
