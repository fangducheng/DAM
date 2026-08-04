import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private heartbeat?: NodeJS.Timeout;

  onModuleInit(): void {
    this.heartbeat = setInterval(() => {
      this.logger.debug('Worker runtime healthy');
    }, 60_000);
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
  }
}
