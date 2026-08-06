import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { User } from './entities/user.entity';
import { UsernameService } from './username.service';
import { MeController, UsernamesController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User]), LeaderboardModule],
  controllers: [MeController, UsernamesController],
  providers: [UsersService, UsernameService],
  exports: [UsersService, UsernameService],
})
export class UsersModule {}
