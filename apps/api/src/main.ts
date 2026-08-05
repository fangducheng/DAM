import 'reflect-metadata';

import helmet from '@fastify/helmet';
import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.register(helmet, { contentSecurityPolicy: false });

  const config = app.get(ConfigService);
  app.enableCors({
    origin: config.getOrThrow<string>('WEB_ORIGIN'),
    credentials: true,
  });

  const openApi = new DocumentBuilder()
    .setTitle('Enterprise DAM API')
    .setDescription('Private digital asset management service')
    .setVersion(config.get<string>('APP_VERSION', '0.1.0'))
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openApi));

  const port = config.getOrThrow<number>('API_PORT');
  await app.listen(port, '0.0.0.0');
  NestLogger.log(`DAM API listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
