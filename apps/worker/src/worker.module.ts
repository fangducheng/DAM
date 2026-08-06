import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { validateEnvironment } from '@dam/config';

import { ObjectStorageService } from './infrastructure/object-storage.service.js';
import { PrismaService } from './infrastructure/prisma.service.js';
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
    WorkerRuntimeService,
  ],
})
export class WorkerModule {}
