import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';

import { PrismaService } from '../infrastructure/prisma.service.js';
import type { AuditPageQueryDto } from './dto/discovery.dto.js';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthenticatedUser, query: AuditPageQueryDto) {
    const events = await this.prisma.auditEvent.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId }),
        ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
        ...(query.resourceId === undefined ? {} : { resourceId: query.resourceId }),
        ...(query.result === undefined ? {} : { result: query.result }),
        ...(query.occurredFrom === undefined && query.occurredTo === undefined
          ? {}
          : {
              occurredAt: {
                ...(query.occurredFrom === undefined ? {} : { gte: new Date(query.occurredFrom) }),
                ...(query.occurredTo === undefined ? {} : { lte: new Date(query.occurredTo) }),
              },
            }),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: {
        id: true,
        occurredAt: true,
        actorUserId: true,
        action: true,
        resourceType: true,
        resourceId: true,
        result: true,
        ipAddress: true,
        userAgent: true,
        requestId: true,
        beforeData: true,
        afterData: true,
        details: true,
        actor: { select: { displayName: true, email: true } },
      },
    });
    const items = events.slice(0, query.limit);
    return {
      items,
      nextCursor:
        events.length > query.limit && items.length > 0 ? items[items.length - 1]!.id : null,
    };
  }
}
