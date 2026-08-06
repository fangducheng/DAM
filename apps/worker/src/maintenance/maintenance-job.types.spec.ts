import { describe, expect, it } from 'vitest';

import { maintenanceRetryDelaySeconds } from './maintenance-job.types.js';

describe('maintenance retry delay', () => {
  it('backs off exponentially and caps at one hour', () => {
    expect(maintenanceRetryDelaySeconds(1, 5)).toBe(5);
    expect(maintenanceRetryDelaySeconds(4, 5)).toBe(40);
    expect(maintenanceRetryDelaySeconds(20, 5)).toBe(3_600);
  });
});
