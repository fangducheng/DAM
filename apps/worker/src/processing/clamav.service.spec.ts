import { describe, expect, it } from 'vitest';

import { parseClamAvResponse } from './clamav.service.js';

describe('parseClamAvResponse', () => {
  it('recognizes clean and infected responses', () => {
    expect(parseClamAvResponse('stream: OK\0')).toEqual({ status: 'CLEAN' });
    expect(parseClamAvResponse('stream: Eicar-Signature FOUND\0')).toEqual({
      status: 'INFECTED',
      signature: 'Eicar-Signature',
    });
  });

  it('rejects daemon errors and empty responses', () => {
    expect(() => parseClamAvResponse('stream: size limit exceeded. ERROR\0')).toThrow();
    expect(() => parseClamAvResponse('')).toThrow();
  });
});
