import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, type BucketItem } from 'minio';

export interface TenantStorageObject {
  objectKey: string;
  sizeBytes: bigint;
  lastModified: Date;
}

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

  bucketName(): string {
    return this.bucket;
  }

  async *listTenantObjects(tenantId: string): AsyncGenerator<TenantStorageObject> {
    const prefix = `tenants/${tenantId}/`;
    const objects = this.client.listObjectsV2(
      this.bucket,
      prefix,
      true,
    ) as AsyncIterable<BucketItem>;
    for await (const object of objects) {
      if (object.name === undefined) {
        continue;
      }
      yield {
        objectKey: object.name,
        sizeBytes: BigInt(object.size),
        lastModified: object.lastModified,
      };
    }
  }

  async objectExists(bucket: string, objectKey: string): Promise<boolean> {
    try {
      await this.client.statObject(bucket, objectKey);
      return true;
    } catch (error) {
      if (this.isMissingObjectError(error)) {
        return false;
      }
      throw error;
    }
  }

  initiateMultipart(objectKey: string, mimeType: string): Promise<string> {
    return this.client.initiateNewMultipartUpload(this.bucket, objectKey, {
      'Content-Type': mimeType,
    });
  }

  presignMultipartPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    expiresSeconds: number,
  ): Promise<string> {
    return this.client.presignedUrl('PUT', this.bucket, objectKey, expiresSeconds, {
      partNumber: String(partNumber),
      uploadId,
    });
  }

  async completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: Array<{ part: number; etag: string }>,
  ): Promise<void> {
    await this.client.completeMultipartUpload(this.bucket, objectKey, uploadId, parts);
  }

  abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    return this.client.abortMultipartUpload(this.bucket, objectKey, uploadId);
  }

  async objectSize(objectKey: string): Promise<bigint> {
    const stat = await this.client.statObject(this.bucket, objectKey);
    return BigInt(stat.size);
  }

  async sha256(objectKey: string): Promise<string> {
    const stream = await this.client.getObject(this.bucket, objectKey);
    const hash = createHash('sha256');
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }

  removeObject(objectKey: string): Promise<void> {
    return this.client.removeObject(this.bucket, objectKey);
  }

  presignRead(
    objectKey: string,
    expiresSeconds: number,
    responseHeaders: Record<string, string>,
  ): Promise<string> {
    return this.client.presignedGetObject(this.bucket, objectKey, expiresSeconds, responseHeaders);
  }

  private isMissingObjectError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return false;
    }
    return ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(String(error.code));
  }
}
