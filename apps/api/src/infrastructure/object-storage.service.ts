import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';

@Injectable()
export class ObjectStorageService {
  private readonly client: Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const endpoint = new URL(config.getOrThrow<string>('MINIO_ENDPOINT'));
    this.bucket = config.getOrThrow<string>('MINIO_BUCKET');
    this.client = new Client({
      endPoint: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
      useSSL: endpoint.protocol === 'https:',
      accessKey: config.getOrThrow<string>('MINIO_ACCESS_KEY'),
      secretKey: config.getOrThrow<string>('MINIO_SECRET_KEY'),
    });
  }

  async ping(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      throw new Error(`Required bucket '${this.bucket}' does not exist`);
    }
  }
}
