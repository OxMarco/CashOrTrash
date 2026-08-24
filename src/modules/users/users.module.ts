import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ItemCopy } from '../catalog/entities/item-copy.entity';
import { CurrencyModule } from '../currency/currency.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { GameSession } from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { User } from './entities/user.entity';
import { UsernameService } from './username.service';
import { MeController, UsernamesController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, GameSession, SessionRound, ItemCopy]),
    CurrencyModule,
    LeaderboardModule,
  ],
  controllers: [MeController, UsernamesController],
  providers: [UsersService, UsernameService],
  exports: [UsersService, UsernameService],
})
export class UsersModule {}
