import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  constructor(private readonly config: ConfigService) {}

  async ping(): Promise<void> {
    const client = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      connectTimeout: 1_500,
      commandTimeout: 1_500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

    try {
      await client.connect();
      await client.ping();
    } finally {
      client.disconnect();
    }
  }
}
