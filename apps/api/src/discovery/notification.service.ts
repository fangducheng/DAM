import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';

import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { NotificationPageQueryDto, UpdateNotificationDto } from './dto/discovery.dto.js';

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthenticatedUser, query: NotificationPageQueryDto) {
    const [records, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          userId: actor.userId,
          ...(query.status === undefined ? {} : { status: query.status }),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
        select: {
          id: true,
          type: true,
          payload: true,
          status: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.count({ where: { userId: actor.userId, status: 'UNREAD' } }),
    ]);
    const items = records.slice(0, query.limit);
    return {
      items,
      unreadCount,
      nextCursor:
        records.length > query.limit && items.length > 0 ? items[items.length - 1]!.id : null,
    };
  }

  async update(actor: AuthenticatedUser, notificationId: string, input: UpdateNotificationDto) {
    const updated = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId: actor.userId },
      data: {
        status: input.status,
        ...(input.status === 'READ' ? { readAt: new Date() } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '通知不存在或你无权查看');
    }
    return this.prisma.notification.findUniqueOrThrow({
      where: { id: notificationId },
      select: {
        id: true,
        type: true,
        payload: true,
        status: true,
        readAt: true,
        createdAt: true,
      },
    });
  }

  async readAll(actor: AuthenticatedUser) {
    const updated = await this.prisma.notification.updateMany({
      where: { userId: actor.userId, status: 'UNREAD' },
      data: { status: 'READ', readAt: new Date() },
    });
    return { updated: updated.count };
  }
}
