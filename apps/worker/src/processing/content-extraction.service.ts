import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ExtractedContent {
  content: string;
  parserVersion: string;
}

export async function boundedUtf8Text(
  chunks: AsyncIterable<Uint8Array | string>,
  maxChars: number,
): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let content = '';
  for await (const value of chunks) {
    content += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
    if (content.length >= maxChars) {
      return content.slice(0, maxChars);
    }
  }
  content += decoder.decode();
  return content.slice(0, maxChars);
}

@Injectable()
export class ContentExtractionService {
  private readonly tikaEnabled: boolean;
  private readonly tikaEndpoint: string;
  private readonly tikaTimeoutMs: number;
  private readonly maxChars: number;

  constructor(config: ConfigService) {
    this.tikaEnabled = config.getOrThrow<boolean>('TIKA_ENABLED');
    this.tikaEndpoint = config.getOrThrow<string>('TIKA_ENDPOINT');
    this.tikaTimeoutMs = config.getOrThrow<number>('TIKA_TIMEOUT_MS');
    this.maxChars = config.getOrThrow<number>('CONTENT_EXTRACTION_MAX_CHARS');
  }

  async extract(mimeType: string, stream: Readable): Promise<ExtractedContent | null> {
    try {
      if (this.isPlainText(mimeType)) {
        return {
          content: await boundedUtf8Text(stream, this.maxChars),
          parserVersion: 'utf8-v1',
        };
      }
      if (!this.tikaEnabled) {
        return null;
      }
      return await this.extractWithTika(mimeType, stream);
    } finally {
      stream.destroy();
    }
  }

  private async extractWithTika(mimeType: string, stream: Readable): Promise<ExtractedContent> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.tikaTimeoutMs);
    timeout.unref();
    try {
      const endpoint = new URL(
        'tika',
        this.tikaEndpoint.endsWith('/') ? this.tikaEndpoint : `${this.tikaEndpoint}/`,
      );
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { accept: 'text/plain', 'content-type': mimeType },
        body: stream,
        duplex: 'half',
        signal: abort.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`Tika extraction failed with HTTP ${response.status}`);
      }
      return {
        content: await boundedUtf8Text(response.body, this.maxChars),
        parserVersion: 'tika-http-v1',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private isPlainText(mimeType: string): boolean {
    return (
      mimeType.startsWith('text/') ||
      [
        'application/json',
        'application/ld+json',
        'application/xml',
        'application/javascript',
        'application/x-yaml',
      ].includes(mimeType)
    );
  }
}
