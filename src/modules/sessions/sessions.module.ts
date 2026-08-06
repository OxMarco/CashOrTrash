import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CatalogModule } from '../catalog/catalog.module';
import { CurrencyModule } from '../currency/currency.module';
import { DailyModule } from '../daily/daily.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { MatchesModule } from '../matches/matches.module';
import { ScoringModule } from '../scoring/scoring.module';
import { UsersModule } from '../users/users.module';
import { GameSession } from './entities/game-session.entity';
import { SessionRound } from './entities/session-round.entity';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([GameSession, SessionRound]),
    CatalogModule,
    CurrencyModule,
    DailyModule,
    ScoringModule,
    UsersModule,
    LeaderboardModule,
    MatchesModule,
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
