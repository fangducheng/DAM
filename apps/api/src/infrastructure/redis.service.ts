import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private connection: Promise<void> | null = null;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      connectTimeout: 1_500,
      commandTimeout: 1_500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<void> {
    await this.ensureConnected();
    await this.client.ping();
  }

  async getJson<T>(key: string): Promise<T | null> {
    await this.ensureConnected();
    const value = await this.client.get(key);
    return value === null ? null : (JSON.parse(value) as T);
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.ensureConnected();
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'ready') {
      return;
    }

    if (this.connection === null) {
      this.connection = this.client
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connection = null;
        });
    }

    await this.connection;
  }
}
