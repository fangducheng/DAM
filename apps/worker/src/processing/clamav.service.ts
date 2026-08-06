import { createConnection, type Socket } from 'node:net';
import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type MalwareScanResult = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string };

export function parseClamAvResponse(response: string): MalwareScanResult {
  const normalized = response.replace(/\0/g, '').trim();
  if (/^(stream|.*): OK$/i.test(normalized)) {
    return { status: 'CLEAN' };
  }
  const infected = /^(?:stream|.*): (.+) FOUND$/i.exec(normalized);
  if (infected?.[1]) {
    return { status: 'INFECTED', signature: infected[1] };
  }
  throw new Error(`ClamAV rejected the scan: ${normalized || 'empty response'}`);
}

@Injectable()
export class ClamAvService {
  private readonly enabled: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maxStreamBytes: number;

  constructor(config: ConfigService) {
    this.enabled = config.getOrThrow<boolean>('CLAMAV_ENABLED');
    this.host = config.getOrThrow<string>('CLAMAV_HOST');
    this.port = config.getOrThrow<number>('CLAMAV_PORT');
    this.timeoutMs = config.getOrThrow<number>('CLAMAV_TIMEOUT_MS');
    this.maxStreamBytes = config.getOrThrow<number>('CLAMAV_MAX_STREAM_BYTES');
  }

  async scan(stream: Readable): Promise<MalwareScanResult> {
    if (!this.enabled) {
      stream.destroy();
      throw new Error('ClamAV processing capability is not enabled');
    }

    const socket = await this.connect();
    let bytes = 0;
    try {
      socket.write('zINSTREAM\0');
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        bytes += chunk.length;
        if (bytes > this.maxStreamBytes) {
          throw new Error(`File exceeds ClamAV stream limit of ${this.maxStreamBytes} bytes`);
        }
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(chunk.length);
        await this.write(socket, header);
        await this.write(socket, chunk);
      }
      await this.write(socket, Buffer.alloc(4));
      return parseClamAvResponse(await this.response(socket));
    } finally {
      stream.destroy();
      socket.destroy();
    }
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(this.timeoutMs);
      socket.once('connect', () => resolve(socket));
      socket.once('error', fail);
      socket.once('timeout', () => fail(new Error('ClamAV connection timed out')));
    });
  }

  private write(socket: Socket, data: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  private response(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      let response = '';
      const finish = () => resolve(response);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        response += chunk;
        if (response.includes('\0') || response.includes('\n')) {
          finish();
        }
      });
      socket.once('end', finish);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('ClamAV scan timed out')));
    });
  }
}
