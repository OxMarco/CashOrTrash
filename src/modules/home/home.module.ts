import { Module } from '@nestjs/common';

import { DailyModule } from '../daily/daily.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { SessionsModule } from '../sessions/sessions.module';
import { UsersModule } from '../users/users.module';
import { HomeController } from './home.controller';

@Module({
  imports: [UsersModule, DailyModule, SessionsModule, LeaderboardModule],
  controllers: [HomeController],
})
export class HomeModule {}
