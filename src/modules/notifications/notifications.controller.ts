import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PushRegistrationDto, RegisterPushTokenDto } from './dto/push.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@Controller('me/push')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Register a push token. Called only after the player taps "Notify me".',
  })
  async register(
    @CurrentUser('id') userId: number,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<PushRegistrationDto> {
    return this.notifications.register(userId, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disable all push notifications for this player.' })
  async unregister(@CurrentUser('id') userId: number): Promise<void> {
    await this.notifications.deactivateForUser(userId);
  }
}
