import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GameSession } from '../sessions/entities/game-session.entity';
import { User } from '../users/entities/user.entity';
import { PushToken } from './entities/push-token.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushConfig } from 'src/config/configuration';
import { ExpoPushSender, LoggingPushSender, PushSender } from './push-sender';

@Module({
  imports: [TypeOrmModule.forFeature([PushToken, User, GameSession])],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    LoggingPushSender,
    ExpoPushSender,
    {
      provide: PushSender,
      inject: [ConfigService, LoggingPushSender, ExpoPushSender],
      useFactory: (
        config: ConfigService,
        logging: LoggingPushSender,
        expo: ExpoPushSender,
      ) =>
        config.getOrThrow<PushConfig>('push').provider === 'expo'
          ? expo
          : logging,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
