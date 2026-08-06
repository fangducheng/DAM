import { describe, expect, it } from 'vitest';

import { retryDelaySeconds } from './processing-job.types.js';

describe('retryDelaySeconds', () => {
  it('uses bounded exponential backoff', () => {
    expect(retryDelaySeconds(1, 5)).toBe(5);
    expect(retryDelaySeconds(4, 5)).toBe(40);
    expect(retryDelaySeconds(20, 5)).toBe(300);
  });
});
