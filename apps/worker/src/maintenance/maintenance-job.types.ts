import type { MaintenanceJobType, Prisma } from '@dam/database';

export interface ClaimedMaintenanceJob {
  id: string;
  idempotencyKey: string;
  tenantId: string | null;
  spaceId: string | null;
  jobType: MaintenanceJobType;
  targetId: string | null;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
}

export function maintenanceRetryDelaySeconds(attempt: number, baseSeconds: number): number {
  return Math.min(baseSeconds * 2 ** Math.max(0, attempt - 1), 3_600);
}
