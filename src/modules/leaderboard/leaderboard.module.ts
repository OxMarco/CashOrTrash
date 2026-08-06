import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../users/entities/user.entity';
import { DailyScore } from './entities/daily-score.entity';
import { Friendship } from '../friends/entities/friendship.entity';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardListener } from './leaderboard.listener';
import { LeaderboardService } from './leaderboard.service';

/**
 * Depends on the User *repository* rather than UsersService: UsersModule needs
 * the leaderboard for the global-rank field on `/me`, and going through the
 * service in both directions would make the pair circular.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DailyScore, Friendship, User])],
  controllers: [LeaderboardController],
  providers: [LeaderboardService, LeaderboardListener],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
