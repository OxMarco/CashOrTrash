# CashOrTrash — Backend Implementation Plan

NestJS API for the CashOrTrash price-guessing game. Source of truth for product behaviour is
`sources/README.md`.

**Guiding principle:** prefer NestJS core abstractions and first-party/community packages over
handwritten equivalents. Where this plan specifies custom code, it is because no package covers it
(the scoring engine, the domain schema) or because the framework default is _wrong_ for our
topology (see "Cluster-safe scheduling").

---

## 1. The one non-negotiable constraint

**`truePriceCents` must never reach the client before a bet is placed.** Scoring is server-
authoritative. Everything else in this document is a tradeoff; this is a correctness boundary.

We enforce it with the framework rather than with discipline, in three layers:

1. `Item.truePriceCents` carries `@Exclude()` from `class-transformer`.
2. Global `ClassSerializerInterceptor` configured with **`excludeExtraneousValues: true`** — fields
   serialize _only_ if explicitly `@Expose()`d on a response DTO. Opt-in, not opt-out.
3. Controllers never return entities. They return response DTO instances. The only DTO that exposes
   the true price is `RevealResponseDto`, returned exclusively from the bet endpoint.

A test in `test/integrity/price-leak.e2e-spec.ts` walks every non-reveal endpoint and asserts the
true price string appears in no response body. This test is the guard rail; treat a failure as a
release blocker.

---

## 2. Stack

Let `@nestjs/cli` pin versions at scaffold time rather than hardcoding them here — align peers to
whatever major the CLI installs.

| Concern       | Package                                                                          | Notes                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP platform | `@nestjs/platform-fastify`                                                       | First-party adapter. No legacy Express middleware to accommodate, so take the throughput. Fall back to `platform-express` if a package fights it. |
| Config        | `@nestjs/config`                                                                 | `isGlobal: true`, `validationSchema` via Joi. Fail fast on boot for missing env.                                                                  |
| ORM           | `@nestjs/typeorm` + `typeorm` + `pg`                                             | `synchronize: true` everywhere. The entities are the schema; there are no migrations. See the README's "Schema changes".                          |
| Queues / cron | `@nestjs/bullmq` + `bullmq`                                                      | Also our scheduler — see §6.                                                                                                                      |
| Redis client  | `ioredis`                                                                        | Shared instance provider; consumed by BullMQ, cache, throttler, socket.io adapter.                                                                |
| Health        | `@nestjs/terminus`                                                               | `/health/live` + `/health/ready`.                                                                                                                 |
| Rate limiting | `@nestjs/throttler` + Redis storage                                              | Redis-backed so limits hold across replicas.                                                                                                      |
| Caching       | `@nestjs/cache-manager`                                                          | Redis store via Keyv. For `/themes`, `/home`.                                                                                                     |
| Domain events | `@nestjs/event-emitter`                                                          | Decouples modules in-process (bet placed → leaderboard, → opponent socket).                                                                       |
| Auth          | `@nestjs/jwt` + `@nestjs/passport` + `passport-jwt`                              | Global `JwtAuthGuard`, `@Public()` escape hatch via `Reflector`.                                                                                  |
| Realtime      | `@nestjs/websockets` + `@nestjs/platform-socket.io` + `@socket.io/redis-adapter` | H2H matches.                                                                                                                                      |
| Validation    | `class-validator` + `class-transformer`                                          | Global `ValidationPipe` (`whitelist`, `transform`, `forbidNonWhitelisted`).                                                                       |
| API docs      | `@nestjs/swagger`                                                                | With the CLI plugin so DTOs self-document. Generates the mobile client.                                                                           |
| Logging       | `nestjs-pino`                                                                    | Structured JSON, request-scoped correlation ids.                                                                                                  |
| Testing       | `@nestjs/testing` + Jest + `supertest` + `@testcontainers/postgresql`            | Real Postgres and Redis in integration tests.                                                                                                     |

---

## 3. Module layout

```
backend/src/
  main.ts                    Fastify adapter, global pipes/interceptors/filters, Swagger
  app.module.ts
  config/                    configuration.ts, env.validation.ts
  common/
    decorators/              @Public(), @CurrentUser()
    guards/                  JwtAuthGuard (global)
    interceptors/            (serializer configured globally in main.ts)
    filters/                 AllExceptionsFilter → RFC7807-ish problem+json
  database/
    schema-extras.ts         the DDL entity metadata cannot express, reapplied on boot
  health/                    Terminus controller + custom Redis/BullMQ indicators
  redis/                     RedisModule — single ioredis provider, re-exported
  modules/
    auth/                    anonymous device auth, JWT issue/refresh, username claim
    users/                   profile, stats, streak maintenance
    catalog/                 items, themes, theme-stats (difficulty labels)
    daily/                   daily challenge issuance + reset countdown
    scoring/                 PURE domain service, versioned constants  ← hand-written by design
    sessions/                game sessions, rounds, bet placement      ← the core
    matches/                 h2h matches, invites, MatchesGateway
    leaderboard/             Redis ZSET service + Postgres source of truth
    notifications/           push tokens, send adapters
    jobs/                    BullMQ processors + queue registration
```

The catalogue is imported from `items/` on boot rather than curated through a
panel; see the backend README. The admin panel and the MCP server that fronted
it were removed when that became the only way in.

---

## 4. Data model (TypeORM entities)

```
User            id, username (unique citext), deviceId (unique), avatarSeed,
                totalPoints, streakDays, streakLastPlayedOn (date),
                bestRoundScore, createdAt
Theme           id, slug, name, isMystery, bonusPct, active
ThemeStat       themeId (PK/FK), avgErrorPct, sampleSize, updatedAt
Item            id, title, conditionLine, photoUrl, truePriceCents @Exclude(),
                sliderMinCents, sliderMaxCents, themeId, sourceUrl, active
DailyChallenge  challengeDate (PK, date, UTC), itemIds (int[] ordered, len 5)
GameSession     id, userId, mode enum(daily|quick|h2h), themeId?, dailyDate?,
                matchId?, itemIds (int[] len 5), currentIndex, totalScore,
                status enum(active|complete|abandoned), createdAt, completedAt
SessionRound    (sessionId, roundIndex) composite PK, itemId, loCents, hiCents,
                multiplier, basePoints, points, hit, errorPct, scoringVersion, placedAt
Match           id, itemIds, themeId, inviteCode (unique), hostUserId, guestUserId?,
                status enum(pending|active|complete), hostScore, guestScore, winnerUserId?
DailyScore      (userId, challengeDate) composite PK, score, rank?, prevRank? (legacy)
Friendship      (userId, friendUserId) composite PK, createdAt
PushToken       id, userId, platform, token (unique), optInAt
```

Two constraints carry real logic and belong in the schema, not in services:

```sql
-- one daily attempt per player per day
CREATE UNIQUE INDEX uq_session_daily
  ON game_session (user_id, daily_date) WHERE mode = 'daily';
```

The `SessionRound` composite PK **is** our bet idempotency. A retried request on a flaky mobile
connection hits a unique violation, which we catch and translate into "return the stored result" —
no double-scoring, no handwritten idempotency-key table.

---

## 5. API surface

```
POST   /v1/auth/anonymous            @Public  {deviceId} → {accessToken, refreshToken}
POST   /v1/auth/refresh              @Public
GET    /v1/usernames/availability    @Public  ?u=  → {available}   [throttled hard]
POST   /v1/me/username                        {username}

GET    /v1/home                               one call fills the entire Home screen
GET    /v1/themes                             incl. difficultyLabel from ThemeStat and iconName;
                                              a theme appears only once it has enough items
                                              to deal a round
GET    /v1/me                                 profile + stats

POST   /v1/sessions                           {mode, themeSlug?} → create OR resume
GET    /v1/sessions/:id/current               item WITHOUT truePrice + slider bounds
POST   /v1/sessions/:id/rounds/:index/bet     {loCents, hiCents} → RevealResponseDto
                                              ⟵ sole egress point for truePrice
GET    /v1/sessions/:id/summary               hits, avgErrorPct, total, rounds[], percentile

POST   /v1/matches                            {themeSlug} → {matchId, inviteCode, deepLink}
POST   /v1/matches/join                       {inviteCode}
GET    /v1/matches/:id
WS     /matches  (socket.io ns)               rooms: match:{id}
                                              events: opponentJoined | opponentPlaced
                                                    | roundAdvanced | matchComplete
                                              ⟵ presence on this socket IS the "vs Maria ●" dot

GET    /v1/leaderboard                        ?scope=today|week|friends
                                              → podium[3], rows[], me{rank,score,delta}, neighbours[]
GET    /v1/friends                            the player's friends, newest first
POST   /v1/friends                            {username} → mutual, idempotent   [throttled hard]
DELETE /v1/friends/:userId                    204, whether or not they were one
POST   /v1/me/push                            called only after "Notify me" is tapped

GET    /media/items/:digest        @Public      washed item photography, outside the /v1 prefix

GET    /health/live   /health/ready  @Public
```

`POST /v1/sessions` for `mode=daily` is idempotent — it returns the in-progress session if one
exists, which is what makes Home's "Continue · round 3" work with no extra endpoint.

### Bet placement — the transactional core

Inside a single TypeORM transaction (`sessions/sessions.service.ts`):

1. Load `GameSession` with `setLock('pessimistic_write')` — serialises concurrent submits.
2. Validate: session `active`, `index === currentIndex`, `loCents < hiCents`, both within the item's
   slider bounds, snapped to the price increment. Anything else → `400`/`409`.
3. `ScoringService.score(...)` — pure, no I/O.
4. Insert `SessionRound`. Unique violation → load and return the existing row (idempotent replay).
5. `totalScore += points`, `currentIndex++`.
6. On `currentIndex === 5`: status `complete`, upsert `DailyScore`, update `User.bestRoundScore` and
   streak, emit `SessionCompletedEvent`.
7. Emit `BetPlacedEvent` — listeners handle the h2h socket push and leaderboard ZADD, so those
   concerns never leak into this method.

---

## 6. Cluster-safe scheduling (read before writing any cron)

`@nestjs/schedule`'s `@Cron()` fires **on every replica**. With two instances, tomorrow's daily
challenge gets generated twice and the rank-snapshot job double-counts. That is a data-integrity
bug, not a performance nit.

**Rule: anything that must run exactly once per tick is a BullMQ repeatable job**, registered on
boot with a stable `jobId` so re-registration is idempotent and exactly one worker claims each tick:

```ts
await this.queue.upsertJobScheduler('daily-challenge-gen', {
  pattern: '0 3 * * *',
});
```

Reserve `@nestjs/schedule` for genuinely replica-local, idempotent work (cache warming, metrics).

Scheduled jobs:

| Job                     | Cadence             | Purpose                                                                                                         |
| ----------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `daily-challenge-gen`   | 03:00 UTC           | Generate `DailyChallenge` for D+1 from a deterministic seed (`hash(date)`) so it is reproducible and auditable. |
| `leaderboard-snapshot`  | 00:05 UTC           | Finalize yesterday's ranks, roll period ZSETs, compute percentiles.                                             |
| `theme-stats-recompute` | hourly              | Refresh `avgErrorPct` → the "Avg ±22%" labels.                                                                  |
| `push-daily-nudge`      | per-timezone bucket | Tomorrow's-challenge and streak-at-risk notifications.                                                          |
| `leaderboard-rebuild`   | on demand           | Reconstruct Redis ZSETs from `DailyScore`. Redis is a cache here, never the source of truth.                    |

---

## 7. Leaderboard topology

Postgres (`DailyScore`) is authoritative. Redis sorted sets are the serving layer:

- Keys: `lb:daily:2026-08-02`, `lb:week:2026-W31`, `lb:friends:{userId}` (ephemeral, built per request from `Friendship` + the daily ZSET).
- Player rank: `ZREVRANK` — O(log n), no table scan.
- Podium + rows: `ZREVRANGE ... WITHSCORES`.
- "You beat **78%** of today's players": `ZCOUNT(-inf, score) / ZCARD`.
- "▲ 41": yesterday's finalized rank minus today's live rank.
- TTLs on daily/weekly keys, and `leaderboard-rebuild` as the recovery path if Redis is flushed.

---

## 8. Scoring engine

The one module written from scratch, deliberately: it is pure domain logic with no framework
surface, and it is the thing most likely to need retuning.

```ts
// modules/scoring/scoring.service.ts
score(input: {
  truePriceCents: number; loCents: number; hiCents: number;
  sliderMinCents: number; sliderMaxCents: number; themeBonusPct: number;
}): {
  hit: boolean; multiplier: number; basePoints: number;
  points: number; errorPct: number; scoringVersion: string;
}
```

Shape, per `sources/README.md` ("base points by closeness of range center + width; multiplier by
range narrowness; miss = 0"):

- `hit = lo <= true <= hi`; **miss → 0 points, short-circuit.**
- `centerError = |center − true| / true`
- `basePoints = round(BASE_MAX × (1 − clamp(centerError / TOLERANCE, 0, 1)))`
- `widthPct = (hi − lo) / (sliderMax − sliderMin)`
- `multiplier` = linear interpolation from `MULT_MIN` (widest) to `MULT_MAX` (narrowest), clamped
- `points = round(basePoints × multiplier × (1 + themeBonusPct))`

Constants live in `modules/scoring/constants/v1.ts` and every `SessionRound` persists its
`scoringVersion`. This is what lets us retune the curve later without invalidating historical
leaderboards or rescoring stored rounds. Target 100% unit coverage — table-driven tests over the
boundary cases (exact-edge hit, zero-width range, center dead-on, widest possible range).

---

## 9. Phases

Each phase ends green: schema applied from the entities, tests passing, Swagger regenerated.

**Phase 0 — Skeleton.** `nest new`, Fastify adapter, `@nestjs/config` with Joi env validation,
`nestjs-pino`, global `ValidationPipe` + serializer (`excludeExtraneousValues: true`) + exception
filter, Terminus `/health/live` + `/health/ready`, Docker Compose (Postgres + Redis), TypeORM
wired to build the schema from the entities on boot, CI running lint/test/build.
_Exit:_ `/health/ready` green against Compose.

**Phase 1 — Scoring engine.** Pure service + v1 constants + exhaustive unit tests. First real code
because it is the thing that must be right and it has zero dependencies.
_Exit:_ 100% coverage on the module; boundary table passes.

**Phase 2 — Identity.** `User` entity, anonymous device auth, JWT issue/refresh, global
`JwtAuthGuard` + `@Public()`, username availability (Redis-throttled, normalised, reserved +
profanity list) and claim.
_Exit:_ e2e for the full onboarding sequence including a username race between two clients.

**Phase 3 — Catalog & daily.** `Item`/`Theme`/`ThemeStat` entities, a seeded catalogue with real items
and verified prices, `GET /v1/themes`, `DailyChallenge` + the seeded generator job, reset countdown.
_Exit:_ two users requesting today's challenge receive an identical ordered item set.

**Phase 4 — The game loop.** `GameSession` + `SessionRound`, session create/resume, `current`, the
transactional bet endpoint, `summary`, `GET /v1/home`, streak maintenance.
_Exit:_ the price-leak integrity test passes; a replayed bet is idempotent; a daily session cannot
be started twice.

**Phase 5 — Leaderboard.** `DailyScore`, Redis ZSET service, `GET /v1/leaderboard` for today/week,
snapshot job for rank deltas, percentile.
_Exit:_ ranks and percentiles agree between Redis and a Postgres `ROW_NUMBER()` cross-check;
`leaderboard-rebuild` restores state after a Redis flush.

**Phase 6 — Head-to-head.** `Match` + invites + deep links, `MatchesGateway` with the socket.io
Redis adapter, event listeners bridging `BetPlacedEvent` to the opponent's socket, friends
leaderboard scope, `Friendship`.
_Exit:_ two clients on _different replicas_ see each other's presence and bets.

**Phase 7 — Notifications & polish.** `PushToken`, send adapter, the per-timezone nudge job,
`theme-stats-recompute`, share-result payload, Swagger → generated mobile client.

Phases 0–5 are the shippable v1. 6 and 7 are v2 as discussed.

---

## 10. Open items

**Scoring constants are not derivable from the prototype — and the summary screen contradicts the
spec.** I checked the hi-fi file. The end-of-game summary shows five rows:

| Row                              | Prototype value |
| -------------------------------- | --------------- |
| Polaroid camera `$140–190`       | `+336`          |
| Office chair `$380–520`          | `+336`          |
| Espresso machine `missed by $90` | `+140`          |
| Wool rug `missed by $210`        | `+90`           |
| Signed vinyl LP `missed by $45`  | `+210`          |
| **Total**                        | **`+1,112`**    |

Two problems. The two _hit_ rows are both `+336` — copy-pasted from the Reveal screen's example
rather than computed. And the three _missed_ rows award 140/90/210 points, which directly
contradicts both `README.md` ("miss the range entirely and score zero") and the h2h Reveal screen
("Maria · missed range → +0"). The total is just the sum of those placeholder rows.

I am treating **`README.md` as authoritative: a miss scores 0**, and the summary's per-item numbers
as decorative mock data. That means the implemented summary screen will show `+0` on missed rows and
a materially lower total than the prototype. Worth confirming, and worth pinning `BASE_MAX`,
`TOLERANCE`, `MULT_MIN`/`MULT_MAX` against intended play — the Reveal example (`140 × 2.4 → +336`
on a dead-centre guess) implies `BASE_MAX ≈ 140`, which would make a perfect 5-hit game land around
`+1,700`.

**Also outstanding:**

- **Item catalog is a content problem, not a code one.** No photos ship with the design bundle. We need real items with _verified, sourced_ prices, plus sensible authored `sliderMin`/`sliderMax` per item (they frame the guess, so they are editorial, not computed).
- **The "washed" photo treatment** (desaturated, low contrast) — apply at ingest with `sharp` and store a derivative, rather than making every client replicate the filter.
- **Daily reset timezone.** Plan assumes UTC everywhere for challenge identity; the Home countdown renders from a server-supplied `resetsAt` instant. Confirm this over a local-midnight-per-player model, which would break "same items for everyone".
- **Anti-automation beyond the basics.** Rate limits and server-side truth cover casual cheating. A minimum time-on-round threshold is cheap insurance if scripted play appears.
