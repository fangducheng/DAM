import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './index.js';

describe('validateEnvironment', () => {
  it('applies safe local defaults', () => {
    const environment = validateEnvironment({});

    expect(environment.API_PORT).toBe(3000);
    expect(environment.DATABASE_URL).toContain('localhost:5433');
    expect(environment.NODE_ENV).toBe('development');
  });

  it('rejects an invalid API port', () => {
    expect(() => validateEnvironment({ API_PORT: '70000' })).toThrow();
  });
});
