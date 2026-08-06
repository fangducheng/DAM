import type { Readable } from 'node:stream';

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

  getObject(objectKey: string): Promise<Readable> {
    return this.client.getObject(this.bucket, objectKey);
  }

  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    try {
      await this.client.abortMultipartUpload(this.bucket, objectKey, uploadId);
    } catch (error) {
      if (this.errorCode(error) !== 'NoSuchUpload') throw error;
    }
  }

  async removeObject(bucket: string, objectKey: string): Promise<void> {
    if (bucket !== this.bucket) throw new Error('Storage deletion requested for an invalid bucket');
    await this.client.removeObject(this.bucket, objectKey);
  }

  private errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined;
  }
}
