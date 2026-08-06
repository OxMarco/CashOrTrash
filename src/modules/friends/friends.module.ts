import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersModule } from '../users/users.module';
import { Friendship } from './entities/friendship.entity';
import { User } from '../users/entities/user.entity';
import { FriendsController } from './friends.controller';
import { FriendsService } from './friends.service';

/**
 * Owns the `Friendship` table. LeaderboardModule reads it too — for the
 * `?scope=friends` board — but only through `TypeOrmModule.forFeature`, so the
 * two modules share an entity without either depending on the other.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Friendship, User]), UsersModule],
  controllers: [FriendsController],
  providers: [FriendsService],
  exports: [FriendsService],
})
export class FriendsModule {}
