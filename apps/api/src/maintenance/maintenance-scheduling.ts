import type { Prisma } from '@dam/database';

export const recycleRetentionDays = 30;

interface DeletionSchedule {
  id: string;
  tenantId: string;
  spaceId: string;
  purgeAt: Date;
}

export async function scheduleDeletionMaintenance(
  database: Prisma.TransactionClient,
  batch: DeletionSchedule,
): Promise<void> {
  const dayMs = 24 * 60 * 60 * 1_000;
  await database.maintenanceJob.createMany({
    data: [
      {
        tenantId: batch.tenantId,
        spaceId: batch.spaceId,
        jobType: 'RETENTION_WARNING',
        idempotencyKey: `deletion:${batch.id}:warning:7`,
        targetId: batch.id,
        payload: { daysRemaining: 7 },
        availableAt: new Date(batch.purgeAt.getTime() - 7 * dayMs),
      },
      {
        tenantId: batch.tenantId,
        spaceId: batch.spaceId,
        jobType: 'RETENTION_WARNING',
        idempotencyKey: `deletion:${batch.id}:warning:1`,
        targetId: batch.id,
        payload: { daysRemaining: 1 },
        availableAt: new Date(batch.purgeAt.getTime() - dayMs),
      },
      {
        tenantId: batch.tenantId,
        spaceId: batch.spaceId,
        jobType: 'PURGE_DELETION_BATCH',
        idempotencyKey: `deletion:${batch.id}:purge`,
        targetId: batch.id,
        availableAt: batch.purgeAt,
      },
    ],
    skipDuplicates: true,
  });
}

export async function cancelDeletionMaintenance(
  database: Prisma.TransactionClient,
  batchIds: readonly string[],
): Promise<void> {
  if (batchIds.length === 0) return;
  await database.maintenanceJob.updateMany({
    where: {
      targetId: { in: [...batchIds] },
      jobType: { in: ['RETENTION_WARNING', 'PURGE_DELETION_BATCH'] },
      status: 'PENDING',
    },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
}

export async function scheduleUploadExpiration(
  database: Prisma.TransactionClient,
  input: {
    sessionId: string;
    tenantId: string;
    spaceId: string;
    expiresAt: Date;
  },
): Promise<void> {
  await database.maintenanceJob.createMany({
    data: [
      {
        tenantId: input.tenantId,
        spaceId: input.spaceId,
        jobType: 'EXPIRE_UPLOAD_SESSION',
        idempotencyKey: `upload:${input.sessionId}:expire`,
        targetId: input.sessionId,
        availableAt: input.expiresAt,
      },
    ],
    skipDuplicates: true,
  });
}
