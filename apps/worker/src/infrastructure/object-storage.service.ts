import * as http from 'node:http';
import * as https from 'node:https';
import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, type BucketItem } from 'minio';

const storageTimeoutMessage = 'Object storage operation timed out';

class ObjectStorageTimeoutError extends Error {
  readonly code = 'OBJECT_STORAGE_TIMEOUT';

  constructor() {
    super(storageTimeoutMessage);
    this.name = 'ObjectStorageTimeoutError';
  }
}

export interface TenantStorageObject {
  objectKey: string;
  sizeBytes: bigint;
  lastModified: Date;
}

export interface TenantStorageObjectPage {
  items: TenantStorageObject[];
  nextCursor: string | null;
}

@Injectable()
export class ObjectStorageService {
  private readonly client: Client;
  private readonly bucket: string;
  private readonly operationTimeoutMs: number;

  constructor(config: ConfigService) {
    const endpoint = new URL(config.getOrThrow<string>('MINIO_ENDPOINT'));
    this.bucket = config.getOrThrow<string>('MINIO_BUCKET');
    this.operationTimeoutMs = config.get<number>('MINIO_OPERATION_TIMEOUT_MS') ?? 30_000;
    const transportRequest: (
      options: http.RequestOptions,
      callback?: (response: http.IncomingMessage) => void,
    ) => http.ClientRequest = endpoint.protocol === 'https:' ? https.request : http.request;
    this.client = new Client({
      endPoint: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
      useSSL: endpoint.protocol === 'https:',
      accessKey: config.getOrThrow<string>('MINIO_ACCESS_KEY'),
      secretKey: config.getOrThrow<string>('MINIO_SECRET_KEY'),
      transport: {
        request: ((
          options: http.RequestOptions,
          callback?: (response: http.IncomingMessage) => void,
        ) => {
          const request = transportRequest(options, callback);
          request.setTimeout(this.operationTimeoutMs, () => {
            request.destroy(new ObjectStorageTimeoutError());
          });
          return request;
        }) as typeof http.request,
      },
    });
  }

  getObject(objectKey: string): Promise<Readable> {
    return this.client.getObject(this.bucket, objectKey);
  }

  bucketName(): string {
    return this.bucket;
  }

  async listTenantObjectsPage(
    tenantId: string,
    startAfter: string | null,
    limit: number,
  ): Promise<TenantStorageObjectPage> {
    const prefix = `tenants/${tenantId}/`;
    if (startAfter !== null && !startAfter.startsWith(prefix)) {
      throw new Error('Storage reconciliation cursor is invalid');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Storage reconciliation page size is invalid');
    }
    const stream = this.client.listObjectsV2(this.bucket, prefix, true, startAfter ?? undefined);
    const objects = stream as AsyncIterable<BucketItem>;
    const items: TenantStorageObject[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      stream.destroy(new ObjectStorageTimeoutError());
    }, this.operationTimeoutMs);
    timeout.unref();
    try {
      for await (const object of objects) {
        if (object.name === undefined) continue;
        items.push({
          objectKey: object.name,
          sizeBytes: BigInt(object.size),
          lastModified: object.lastModified,
        });
        if (items.length >= limit) {
          stream.destroy();
          return { items, nextCursor: object.name };
        }
      }
      return { items, nextCursor: null };
    } catch (error) {
      if (timedOut || error instanceof ObjectStorageTimeoutError) {
        throw new ObjectStorageTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async objectExists(bucket: string, objectKey: string): Promise<boolean> {
    if (bucket !== this.bucket) throw new Error('Storage lookup requested for an invalid bucket');
    try {
      await this.withTimeout(this.client.statObject(this.bucket, objectKey));
      return true;
    } catch (error) {
      if (['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(this.errorCode(error) ?? '')) {
        return false;
      }
      throw error;
    }
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

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new ObjectStorageTimeoutError()),
            this.operationTimeoutMs,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
