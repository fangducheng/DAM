import { Readable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface ListedObject {
  name: string;
  size: number;
  lastModified: Date;
}

interface ListedStream extends AsyncIterable<ListedObject> {
  readonly destroyed: boolean;
  destroy(error?: Error): void;
}

const client = vi.hoisted(() => ({
  listObjectsV2:
    vi.fn<
      (bucket: string, prefix: string, recursive: boolean, startAfter?: string) => ListedStream
    >(),
  statObject: vi.fn<(bucket: string, objectKey: string) => Promise<unknown>>(),
}));

vi.mock('minio', () => ({
  Client: class MockClient {
    listObjectsV2(
      bucket: string,
      prefix: string,
      recursive: boolean,
      startAfter?: string,
    ): ListedStream {
      return client.listObjectsV2(bucket, prefix, recursive, startAfter);
    }

    statObject(bucket: string, objectKey: string): Promise<unknown> {
      return client.statObject(bucket, objectKey);
    }
  },
}));

import { ObjectStorageService } from './object-storage.service.js';

function createStorage() {
  const values: Record<string, string | number> = {
    MINIO_ENDPOINT: 'http://localhost:9000',
    MINIO_BUCKET: 'dam-assets',
    MINIO_ACCESS_KEY: 'test-access',
    MINIO_SECRET_KEY: 'test-secret',
    MINIO_OPERATION_TIMEOUT_MS: 25,
  };
  const config = {
    get: vi.fn((key: string) => values[key]),
    getOrThrow: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  return new ObjectStorageService(config);
}

function objects(values: ListedObject[]): ListedStream {
  return Readable.from(values, { objectMode: true });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ObjectStorageService reconciliation support', () => {
  it('returns a bounded Tenant page with a resumable start-after cursor', async () => {
    const firstModified = new Date('2026-08-07T01:00:00.000Z');
    const secondModified = new Date('2026-08-07T02:00:00.000Z');
    client.listObjectsV2.mockReturnValue(
      objects([
        { name: 'tenants/tenant-id/objects/a', size: 10, lastModified: firstModified },
        { name: 'tenants/tenant-id/objects/b', size: 20, lastModified: secondModified },
        { name: 'tenants/tenant-id/objects/c', size: 30, lastModified: secondModified },
      ]),
    );
    const storage = createStorage();

    await expect(
      storage.listTenantObjectsPage('tenant-id', 'tenants/tenant-id/objects/previous', 2),
    ).resolves.toEqual({
      items: [
        {
          objectKey: 'tenants/tenant-id/objects/a',
          sizeBytes: 10n,
          lastModified: firstModified,
        },
        {
          objectKey: 'tenants/tenant-id/objects/b',
          sizeBytes: 20n,
          lastModified: secondModified,
        },
      ],
      nextCursor: 'tenants/tenant-id/objects/b',
    });
    expect(client.listObjectsV2).toHaveBeenCalledWith(
      'dam-assets',
      'tenants/tenant-id/',
      true,
      'tenants/tenant-id/objects/previous',
    );
  });

  it('rejects a cursor outside the Tenant prefix before listing objects', async () => {
    const storage = createStorage();

    await expect(
      storage.listTenantObjectsPage('tenant-id', 'tenants/other-tenant/objects/a', 250),
    ).rejects.toThrow('Storage reconciliation cursor is invalid');
    expect(client.listObjectsV2).not.toHaveBeenCalled();
  });

  it('maps only missing-object provider responses to a negative existence result', async () => {
    const storage = createStorage();
    client.statObject.mockRejectedValueOnce({ code: 'NoSuchKey' });
    client.statObject.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(storage.objectExists('dam-assets', 'object-a')).resolves.toBe(false);
    await expect(storage.objectExists('dam-assets', 'object-b')).rejects.toThrow(
      'provider unavailable',
    );
  });

  it('cancels a hanging listing stream and returns a safe timeout error', async () => {
    vi.useFakeTimers();
    const hangingStream = new Readable({ objectMode: true, read: vi.fn() }) as ListedStream;
    client.listObjectsV2.mockReturnValue(hangingStream);
    const storage = createStorage();

    const result = storage.listTenantObjectsPage('tenant-id', null, 250);
    const rejection = expect(result).rejects.toThrow('Object storage operation timed out');
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(hangingStream.destroyed).toBe(true);
  });

  it('bounds a hanging object-stat request with the same safe timeout error', async () => {
    vi.useFakeTimers();
    client.statObject.mockReturnValue(new Promise<unknown>(() => undefined));
    const storage = createStorage();

    const result = storage.objectExists('dam-assets', 'object-a');
    const rejection = expect(result).rejects.toThrow('Object storage operation timed out');
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });
});
