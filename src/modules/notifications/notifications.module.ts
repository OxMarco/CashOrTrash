import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GameSession } from '../sessions/entities/game-session.entity';
import { User } from '../users/entities/user.entity';
import { PushToken } from './entities/push-token.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { LoggingPushSender, PushSender } from './push-sender';

@Module({
  imports: [TypeOrmModule.forFeature([PushToken, User, GameSession])],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    // Swap this binding to ship a real provider; nothing else changes.
    { provide: PushSender, useClass: LoggingPushSender },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
