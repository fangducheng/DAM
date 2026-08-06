import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '@dam/contracts';

import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import { NotificationPageQueryDto, UpdateNotificationDto } from './dto/discovery.dto.js';
import { NotificationService } from './notification.service.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(AccessTokenGuard)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'List notifications for the current user' })
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: NotificationPageQueryDto) {
    return this.notifications.list(actor, query);
  }

  @Patch(':notificationId')
  @ApiOperation({ summary: 'Mark one notification as read or archived' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @Body() input: UpdateNotificationDto,
  ) {
    return this.notifications.update(actor, notificationId, input);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every unread notification as read' })
  readAll(@CurrentUser() actor: AuthenticatedUser) {
    return this.notifications.readAll(actor);
  }
}
