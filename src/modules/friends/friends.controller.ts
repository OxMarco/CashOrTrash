import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AddFriendDto, FriendDto, FriendListDto } from './dto/friend.dto';
import { FriendsService } from './friends.service';

@ApiTags('friends')
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get()
  @ApiOperation({ summary: 'The player’s friends, most recently added first.' })
  async list(@CurrentUser('id') userId: number): Promise<FriendListDto> {
    return this.friends.list(userId);
  }

  /**
   * Throttled harder than the default. This endpoint answers "does this
   * username exist" for an authenticated caller, so an unbounded one would let
   * a single account walk the whole user table a name at a time.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Add a friend by handle. Idempotent.' })
  async add(
    @CurrentUser('id') userId: number,
    @Body() dto: AddFriendDto,
  ): Promise<FriendDto> {
    return this.friends.add(userId, dto.username);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a friend. Succeeds whether or not they were one.',
  })
  async remove(
    @CurrentUser('id') userId: number,
    @Param('userId', ParseIntPipe) friendUserId: number,
  ): Promise<void> {
    return this.friends.remove(userId, friendUserId);
  }
}
