import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { boundedUtf8Text } from './content-extraction.service.js';

describe('boundedUtf8Text', () => {
  it('decodes split UTF-8 input and enforces the character limit', async () => {
    const bytes = new TextEncoder().encode('公司资料共享');
    const chunks = Readable.from([bytes.slice(0, 5), bytes.slice(5)]);

    expect(await boundedUtf8Text(chunks, 4)).toBe('公司资料');
  });
});
