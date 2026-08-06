import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';

import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { MaintenanceJobPageQueryDto } from './dto/maintenance.dto.js';

@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(actor: AuthenticatedUser) {
    const [jobs, batches, nextDue] = await Promise.all([
      this.prisma.maintenanceJob.groupBy({
        by: ['status'],
        where: { tenantId: actor.tenantId },
        _count: { _all: true },
      }),
      this.prisma.deletionBatch.groupBy({
        by: ['status'],
        where: { tenantId: actor.tenantId },
        _count: { _all: true },
      }),
      this.prisma.maintenanceJob.findFirst({
        where: { tenantId: actor.tenantId, status: 'PENDING' },
        orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
        select: { availableAt: true },
      }),
    ]);
    return {
      jobs: Object.fromEntries(jobs.map((entry) => [entry.status, entry._count._all])),
      deletionBatches: Object.fromEntries(
        batches.map((entry) => [entry.status, entry._count._all]),
      ),
      nextDueAt: nextDue?.availableAt ?? null,
    };
  }

  async list(actor: AuthenticatedUser, query: MaintenanceJobPageQueryDto) {
    const records = await this.prisma.maintenanceJob.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.jobType === undefined ? {} : { jobType: query.jobType }),
        ...(query.spaceId === undefined ? {} : { spaceId: query.spaceId }),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: {
        id: true,
        spaceId: true,
        jobType: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        availableAt: true,
        leaseExpiresAt: true,
        completedAt: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const items = records.slice(0, query.limit);
    return {
      items,
      nextCursor:
        records.length > query.limit && items.length > 0 ? items[items.length - 1]!.id : null,
    };
  }

  async retry(actor: AuthenticatedUser, jobId: string, metadata: AuthorizationRequestMetadata) {
    return this.prisma.$transaction(async (database) => {
      const job = await database.maintenanceJob.findFirst({
        where: { id: jobId, tenantId: actor.tenantId, status: 'DEAD' },
        select: { id: true, jobType: true, targetId: true },
      });
      if (job === null) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'VERSION_CONFLICT',
          '任务不存在、尚未终止或已经被其他管理员重试',
        );
      }
      if (job.jobType === 'PURGE_DELETION_BATCH' && job.targetId !== null) {
        const batch = await database.deletionBatch.updateMany({
          where: { id: job.targetId, tenantId: actor.tenantId, status: 'FAILED' },
          data: { status: 'PURGE_REQUESTED', errorMessage: null },
        });
        if (batch.count !== 1) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            'VERSION_CONFLICT',
            '删除批次状态已变化，请刷新后重试',
          );
        }
      }
      await database.maintenanceJob.update({
        where: { id: job.id },
        data: {
          status: 'PENDING',
          attempts: 0,
          availableAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          completedAt: null,
          errorMessage: null,
        },
      });
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'maintenance.job.retried',
          resourceType: 'MAINTENANCE_JOB',
          resourceId: job.id,
          result: 'SUCCEEDED',
          ipAddress: metadata.ipAddress ?? null,
          userAgent: metadata.userAgent ?? null,
          requestId: metadata.requestId ?? null,
          details: { jobType: job.jobType },
        },
      });
      return { id: job.id, status: 'PENDING' as const };
    });
  }
}
