import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class AddFriendDto {
  /**
   * By handle, not by id. A player reads a username off a friend's screen or a
   * shared result; they never see the numeric id, and accepting one here would
   * turn the endpoint into an enumeration primitive for the whole user table.
   */
  @ApiProperty({ example: 'maria' })
  @IsString()
  @Length(1, 64)
  username: string;
}

export class FriendDto {
  @ApiProperty()
  @Expose()
  userId: number;

  @ApiProperty({ nullable: true })
  @Expose()
  username: string | null;

  @ApiProperty()
  @Expose()
  avatarSeed: string;

  @ApiProperty()
  @Expose()
  totalPoints: number;

  @ApiProperty({
    description: 'Zero once the streak lapses, whatever is stored.',
  })
  @Expose()
  streakDays: number;

  @ApiProperty({ description: 'When the two became friends.' })
  @Expose()
  friendsSince: Date;
}

export class FriendListDto {
  @ApiProperty({ type: [FriendDto] })
  @Expose()
  @Type(() => FriendDto)
  friends: FriendDto[];

  @ApiProperty()
  @Expose()
  count: number;
}
