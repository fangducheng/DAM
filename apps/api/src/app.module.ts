import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { validateEnvironment } from '@dam/config';

import { AppController } from './app.controller.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';

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
      useFactory: (config: ConfigService) => {
        const development = config.get('NODE_ENV') === 'development';
        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', 'info'),
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
            ...(development
              ? {
                  transport: {
                    target: 'pino-pretty',
                    options: { colorize: true, singleLine: true },
                  },
                }
              : {}),
          },
        };
      },
    }),
    InfrastructureModule,
    HealthModule,
    IdentityModule,
    AuthorizationModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
