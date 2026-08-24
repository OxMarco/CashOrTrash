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

/**
 * The multiplier as a function of bet width — enough of it for a client to draw
 * the same line the server will score on, and nothing else.
 *
 * This is the whole scoring rule the client is trusted with, and it is trusted
 * with it for one reason: the tag under the slider has to read "×2.4" while the
 * thumb is still moving. Everything else — base points, the hit test, the theme
 * bonus, the total — is decided here and sent back as an answer.
 *
 * Shipping it as data rather than letting the client keep a copy of the numbers
 * is not ceremony. A client with its own curve showed "×2.9" on a bet the server
 * then paid ×2.5, because the two curves were written months apart and only one
 * of them was ever retuned.
 */
export class MultiplierCurveDto {
  @ApiProperty({
    description: 'Multiplier at or below `narrowWidthPct` — the narrow end.',
    example: 2.5,
  })
  @Expose()
  max: number;

  @ApiProperty({
    description: 'Multiplier at or above `wideWidthPct` — the wide end.',
    example: 0.2,
  })
  @Expose()
  min: number;

  @ApiProperty({
    description: 'Bet width, as a share of the slider, that earns `max`.',
    example: 0.05,
  })
  @Expose()
  narrowWidthPct: number;

  @ApiProperty({
    description: 'Bet width, as a share of the slider, that earns `min`.',
    example: 1,
  })
  @Expose()
  wideWidthPct: number;

  @ApiProperty({
    description:
      'Decimals the multiplier is rounded to before it is applied. Rounded ' +
      'before, not after, so the arithmetic on the reveal is the arithmetic ' +
      'the player watched.',
    example: 1,
  })
  @Expose()
  decimals: number;

  @ApiProperty({
    description: 'Which constant set produced this curve.',
    example: 'v2',
  })
  @Expose()
  scoringVersion: string;
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

  @ApiProperty({
    type: () => MultiplierCurveDto,
    description:
      'The multiplier curve this round will be scored on. Sent because the ' +
      'gameplay slider has to label the bet while the player is dragging it, ' +
      'which is the one scoring decision a round trip cannot make. It travels ' +
      'with the round rather than being fetched once, so it is always the ' +
      'curve this round is actually scored on — see `scoringVersion`.',
  })
  @Expose()
  @Type(() => MultiplierCurveDto)
  multiplierCurve: MultiplierCurveDto;
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
    description:
      '"You beat 78% of today’s players" — the share of the *other* players ' +
      'scored below this one. Daily sessions only.',
  })
  @Expose()
  percentile: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Competition rank on the day’s board: one more than the number of ' +
      'players strictly ahead, so a tie shares a place. Null wherever ' +
      '`percentile` is.',
  })
  @Expose()
  rank: number | null;

  @ApiProperty({
    description:
      'How many other players sit on exactly this score. Sent so a client can ' +
      'say "tied for first" instead of "you beat 0%", which is what a ' +
      'three-way tie at the top reads as otherwise.',
  })
  @Expose()
  sharedWith: number;

  @ApiProperty({
    nullable: true,
    description:
      'Places gained on the day’s board against yesterday’s final standings ' +
      '(positive = up). Null on the first day played, or wherever `rank` is.',
  })
  @Expose()
  rankDelta: number | null;

  @ApiProperty({
    description:
      'False when this daily score was kept off the board because the account ' +
      'is still inside its probation window. The score still counts toward the ' +
      'player’s own totals and streak; it just does not rank. True everywhere ' +
      'else, including on modes that are not ranked at all — so a client can ' +
      'read it as "is there a reason there is no rank" rather than as a mode ' +
      'test. Sent because an unranked new account and a board that has not ' +
      'answered yet both arrive as a null percentile, and only one of them is ' +
      'worth explaining to the player.',
  })
  @Expose()
  leaderboardEligible: boolean;

  @ApiProperty({ description: 'Prefilled copy for the Share result button.' })
  @Expose()
  shareText: string;

  @ApiPropertyOptional({ type: OpponentStateDto, nullable: true })
  @Expose()
  @Type(() => OpponentStateDto)
  match: OpponentStateDto | null;
}
