import { describe, expect, it } from 'vitest';

import { normalizeResourceName } from './resource-name.js';

describe('normalizeResourceName', () => {
  it('trims and normalizes equivalent Unicode names for conflict checks', () => {
    expect(normalizeResourceName('  Re\u0301sume\u0301.PDF  ')).toEqual({
      name: 'Résumé.PDF',
      normalizedName: 'résumé.pdf',
    });
  });

  it.each(['.', '..', 'contracts/2026.pdf', 'contracts\\2026.pdf', 'bad\u0000name'])(
    'rejects unsafe path-like name %j',
    (name) => {
      expect(() => normalizeResourceName(name)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    },
  );
});
