import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

import {
  Currency,
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
} from '../../currency/currency.constants';
import { GameMode, SessionStatus } from '../entities/game-session.entity';

/**
 * Every `*Cents` field below is in the **minor units of the response's
 * `currency`**, not necessarily in US cents. The name predates the setting and
 * is kept because renaming it would break every client for no gain: a euro is
 * a hundred cents too, and `currency` says which cents these are.
 */

export class CreateSessionDto {
  @ApiProperty({ enum: GameMode })
  @IsEnum(GameMode)
  mode: GameMode;

  @ApiPropertyOptional({
    description:
      'Required for quick and h2h rounds; ignored for daily, which has no theme picker.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  themeSlug?: string;

  @ApiPropertyOptional({ description: 'Joins an existing head-to-head match.' })
  @IsOptional()
  @IsString()
  @Length(4, 12)
  inviteCode?: string;
}

export class PlaceBetDto {
  @ApiProperty({
    description: 'Lower bound, in cents, snapped to the increment.',
  })
  @IsInt()
  @Min(0)
  loCents: number;

  @ApiProperty({
    description: 'Upper bound, in cents, snapped to the increment.',
  })
  @IsInt()
  @Min(0)
  hiCents: number;

  @ApiPropertyOptional({
    enum: SUPPORTED_CURRENCIES,
    default: DEFAULT_CURRENCY,
    description:
      'The currency the two bounds are expressed in. Must be the same one ' +
      'the round was dealt in — the bet is validated against that currency’s ' +
      'slider grid, then converted back to dollars to be scored.',
  })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: Currency;
}

export class SessionDto {
  @ApiProperty()
  @Expose()
  id: string;

  @ApiProperty({ enum: GameMode })
  @Expose()
  mode: GameMode;

  @ApiProperty({ enum: SessionStatus })
  @Expose()
  status: SessionStatus;

  @ApiProperty({ description: 'Index of the next unplayed round.' })
  @Expose()
  currentIndex: number;

  @ApiProperty()
  @Expose()
  roundCount: number;

  @ApiProperty()
  @Expose()
  totalScore: number;

  @ApiProperty({ nullable: true })
  @Expose()
  themeSlug: string | null;

  @ApiProperty({ nullable: true })
  @Expose()
  themeName: string | null;

  @ApiProperty({ nullable: true })
  @Expose()
  matchId: string | null;

  @ApiProperty({
    description: 'True when an in-progress session was returned.',
  })
  @Expose()
  resumed: boolean;
}

/**
 * The gameplay screen's payload. Conspicuously absent: `truePriceCents`.
 * This DTO is the reason the entity is never returned directly.
 */
export class CurrentRoundDto {
  @ApiProperty()
  @Expose()
  sessionId: string;

  @ApiProperty({ description: 'Zero-based; "Round 3 of 5" is index 2.' })
  @Expose()
  roundIndex: number;

  @ApiProperty()
  @Expose()
  roundCount: number;

  @ApiProperty()
  @Expose()
  itemId: number;

  @ApiProperty({ example: 'Designer office chair' })
  @Expose()
  title: string;

  @ApiProperty({ example: 'Lightly used · aluminium base · 2019' })
  @Expose()
  conditionLine: string;

  @ApiProperty()
  @Expose()
  photoUrl: string;

  @ApiProperty({
    enum: SUPPORTED_CURRENCIES,
    description: 'The currency every amount below is in.',
  })
  @Expose()
  currency: Currency;

  @ApiProperty()
  @Expose()
  sliderMinCents: number;

  @ApiProperty()
  @Expose()
  sliderMaxCents: number;

  @ApiProperty({ description: 'Slider step, in cents. Bets must land on it.' })
  @Expose()
  incrementCents: number;

  @ApiProperty({ description: 'Suggested opening range, already snapped.' })
  @Expose()
  suggestedLoCents: number;

  @ApiProperty()
  @Expose()
  suggestedHiCents: number;

  @ApiProperty({ description: 'Running total going into this round.' })
  @Expose()
  totalScore: number;

  @ApiProperty({
    description:
      'Seconds allowed on this round, from when the server dealt it. 0 means ' +
      'the shot clock is off.',
  })
  @Expose()
  roundSeconds: number;

  @ApiProperty({
    nullable: true,
    description:
      'Server-side deadline. Null when the clock is off. Informational — a ' +
      'client should count `remainingMs` down rather than compare this ' +
      'against its own clock.',
  })
  @Expose()
  expiresAt: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'Milliseconds left when this response was built; count down from here. ' +
      '0 means the round is already lost — re-fetching does not reset it, ' +
      'because the deadline is stamped once, when the round is first dealt. ' +
      'Null when the clock is off.',
  })
  @Expose()
  remainingMs: number | null;

  @ApiProperty({ nullable: true, description: 'Set for head-to-head rounds.' })
  @Expose()
  opponentUsername: string | null;
}

export class RoundResultDto {
  @ApiProperty()
  @Expose()
  roundIndex: number;

  @ApiProperty()
  @Expose()
  itemId: number;

  @ApiProperty()
  @Expose()
  title: string;

  @ApiProperty()
  @Expose()
  loCents: number;

  @ApiProperty()
  @Expose()
  hiCents: number;

  @ApiProperty()
  @Expose()
  truePriceCents: number;

  @ApiProperty()
  @Expose()
  hit: boolean;

  @ApiProperty({
    description:
      'The bet reached the server after the round’s deadline and scored ' +
      'nothing. `hit` is false on such a round even when the range did ' +
      'contain the price — compare `truePriceCents` against the bounds to ' +
      'say so.',
  })
  @Expose()
  timedOut: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Server-measured milliseconds spent on the round.',
  })
  @Expose()
  elapsedMs: number | null;

  @ApiProperty({
    description: 'Cents between the guess and the price; 0 on a hit.',
  })
  @Expose()
  missedByCents: number;

  @ApiProperty()
  @Expose()
  basePoints: number;

  @ApiProperty()
  @Expose()
  multiplier: number;

  @ApiProperty()
  @Expose()
  points: number;

  @ApiProperty({ description: 'Signed relative error of the range centre.' })
  @Expose()
  errorPct: number;
}

export class OpponentStateDto {
  @ApiProperty()
  @Expose()
  matchId: string;

  @ApiProperty({ nullable: true })
  @Expose()
  opponentUsername: string | null;

  @ApiProperty()
  @Expose()
  yourScore: number;

  @ApiProperty()
  @Expose()
  opponentScore: number;

  @ApiProperty({
    nullable: true,
    description:
      'Points the opponent scored on this round, once they have played.',
  })
  @Expose()
  opponentRoundPoints: number | null;

  @ApiProperty({
    nullable: true,
    description: '"You lead 3–1", or null while level.',
  })
  @Expose()
  leadLabel: string | null;
}

/**
 * The one and only response that carries `truePriceCents`, returned
 * exclusively from the bet endpoint — after the bet is recorded.
 */
export class RevealResponseDto {
  @ApiProperty()
  @Expose()
  sessionId: string;

  @ApiProperty()
  @Expose()
  @Type(() => RoundResultDto)
  round: RoundResultDto;

  @ApiProperty({
    enum: SUPPORTED_CURRENCIES,
    description: 'The currency every amount below, and inside `round`, is in.',
  })
  @Expose()
  currency: Currency;

  @ApiProperty()
  @Expose()
  sliderMinCents: number;

  @ApiProperty()
  @Expose()
  sliderMaxCents: number;

  @ApiProperty()
  @Expose()
  totalScore: number;

  @ApiProperty({
    nullable: true,
    description: 'Null when the session is over.',
  })
  @Expose()
  nextRoundIndex: number | null;

  @ApiProperty()
  @Expose()
  isSessionComplete: boolean;

  @ApiProperty({
    description: 'True when this response replayed an already-recorded bet.',
  })
  @Expose()
  replayed: boolean;

  @ApiPropertyOptional({ type: OpponentStateDto, nullable: true })
  @Expose()
  @Type(() => OpponentStateDto)
  match: OpponentStateDto | null;
}

export class SessionSummaryDto {
  @ApiProperty()
  @Expose()
  sessionId: string;

  @ApiProperty({ enum: GameMode })
  @Expose()
  mode: GameMode;

  @ApiProperty({ enum: SessionStatus })
  @Expose()
  status: SessionStatus;

  @ApiProperty({
    description: 'Ranges hit, out of roundCount. The "2/5" circle.',
  })
  @Expose()
  hits: number;

  @ApiProperty()
  @Expose()
  roundCount: number;

  @ApiProperty({
    description: 'Mean absolute centre error, 0–1. "avg 18% off".',
  })
  @Expose()
  avgErrorPct: number;

  @ApiProperty()
  @Expose()
  totalScore: number;

  @ApiProperty({
    enum: SUPPORTED_CURRENCIES,
    description: 'The currency the amounts inside `rounds` are in.',
  })
  @Expose()
  currency: Currency;

  @ApiProperty({ type: [RoundResultDto] })
  @Expose()
  @Type(() => RoundResultDto)
  rounds: RoundResultDto[];

  @ApiProperty({
    nullable: true,
    description: '"You beat 78% of today’s players". Daily sessions only.',
  })
  @Expose()
  percentile: number | null;

  @ApiProperty({ description: 'Prefilled copy for the Share result button.' })
  @Expose()
  shareText: string;

  @ApiPropertyOptional({ type: OpponentStateDto, nullable: true })
  @Expose()
  @Type(() => OpponentStateDto)
  match: OpponentStateDto | null;
}
