# CashOrTrash — backend

NestJS API for CashOrTrash, a price-guessing game. The player bets a _range_ rather than a number: a
narrower range pays a higher multiplier, and missing the range scores nothing at all.

Product behaviour is specified in `../sources/README.md`; the engineering plan this implements is
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

---

## The one rule

**`truePriceCents` must never reach the client before a bet is placed.** Everything else here is a
tradeoff; this is a correctness boundary, and it is enforced by the framework rather than by
discipline:

1. `Item.truePriceCents` carries `@Exclude()`.
2. The global serializer runs with `excludeExtraneousValues: true`, so a field reaches the client
   only if a response DTO explicitly `@Expose()`s it — opt-in, not opt-out.
3. Controllers return response DTO instances, never entities. `RevealResponseDto`, returned from
   `POST /sessions/:id/rounds/:index/bet`, is the only DTO that exposes the price.

`test/integrity/price-leak.e2e-spec.ts` walks every non-reveal endpoint and asserts no unrevealed
price appears in the raw response body. **Treat a failure there as a release blocker.**

---

## Running it

Requires **Node 24** — the version in `.nvmrc`, which CI and the runtime image
both track. Docker too, for the dev dependencies and the e2e suite.

```bash
nvm use                 # reads .nvmrc
npm ci
cp .env.example .env

make dev-deps           # Postgres 17 + Redis 7
npm run start:dev
```

The schema is built from the entities on boot (`DATABASE_SYNCHRONIZE`, on by default), so there is
no migration step — in any environment. The catalogue is built from `items/` by a job on boot (see
§"The catalogue is `items/`"). Until at least one theme has `ROUNDS_PER_SESSION` items, the picker
is empty by design.

`make dev` instead runs the app in a container too, hot-reloading from `./src`.
`make help` lists every target.

- API: `http://localhost:3000/v1`
- OpenAPI JSON: `http://localhost:3000/docs/openapi.json` (generates the mobile client)
- Probes: `/health/live`, `/health/ready` — deliberately outside the version prefix, so an
  orchestrator need not know it

### The OpenAPI contract

```bash
npm run openapi:emit   # writes openapi.json — commit the result
```

`openapi.json` at the repository root is the same document `/docs/openapi.json` serves, written to
a file so the mobile client can generate its wire types from it. Commit it: the app checks its
generated types against its copy, so a field renamed here fails the app's build instead of a
player's round.

Emitting needs no database, no Redis and no listening socket — Nest's preview mode builds the
module graph without instantiating a provider — so CI runs it and diffs the result. It does build
first, and must: the `@nestjs/swagger` CLI plugin is what infers a DTO's schema from its
TypeScript types, and it only runs during `nest build`. Straight from source the same document
comes back with 9 schemas instead of 31.

### Schema changes

**There are no migrations in this project, and none are to be added.** The entities are the schema.
Adding a column is an edit to an entity file; the next boot applies it, in development and in
production alike. `SchemaExtras` reapplies on each boot the one index entity metadata cannot
express (`uq_theme_single_active_mystery`, unique across a constant expression).

Know what that costs. `synchronize` reconciles the live schema to the entities in **both**
directions: a column, table, or index it cannot map to an entity is one it drops. Three things
follow, and they are the whole safety story.

- **Anything the database holds that no entity describes will not survive a deploy.** If you need
  it, it needs an entity — or the `SchemaExtras` list, which is reapplied rather than reconciled.
- **`make deploy` takes a dump first** (`make db-backup`, into `./backups`), because the container
  reshapes the live database as it starts and that dump is the only way back. `make db-restore
  FILE=…` is the way back.
- **Booting against the wrong database is destructive, not merely wrong.** Check `DATABASE_NAME`
  before pointing a replica anywhere new.

`DATABASE_SYNCHRONIZE=false` stops all of it, at the price of a schema that nothing then updates.

---

## Deploying

`docker-compose.prod.yaml` is the whole production stack: the app, Postgres, Redis, a nightly
`pg_dump` sidecar, autoheal, and Traefik terminating TLS with Let's Encrypt certificates.

```bash
cp .env.example .env    # set DOMAIN, ACME_EMAIL and real secrets
make up
make deploy             # thereafter: pull, build, back up, recreate, smoke
```

Before the first `make up`, point a DNS **A record for `DOMAIN`** at the host — and one for
`www.DOMAIN` if you want the www redirect, which gets its own certificate. Let's Encrypt validates
over HTTP-01 on `:80`, so without DNS the challenge fails and Traefik serves its self-signed
default certificate instead.

A few things worth knowing:

- **Only Traefik publishes ports.** The app is on `expose`, and Postgres and Redis are reachable
  only over the internal `backend` network. `exposedbydefault=false` means a service cannot be
  published by forgetting a label — it has to opt in.
- **Certificates live in a named volume.** Let's Encrypt rate-limits duplicate certificates to five
  per week, so losing `acme.json` a few times locks the domain out for days. `make down` keeps it.
- **`make deploy` takes a dump before recreating.** There is no migration step: the new container
  applies its entities to the live schema as it boots, dropping whatever it cannot account for
  (see [Schema changes](#schema-changes)). The dump is the rollback.
- **Backups are a bind mount** (`./backups`), not the database's volume, so losing that volume does
  not take the backups down with the data they exist to restore. `make db-restore FILE=…` puts one
  back, with a confirmation prompt.
- **Redis runs with AOF and `noeviction`.** BullMQ's job schedulers are real state — losing them
  means no daily challenge and no evening nudge. The leaderboard ZSETs are rebuildable and the
  cache is TTL-bound, so those would survive a wipe on their own.
- **If you scale the app past one replica**, socket.io's long-polling fallback needs sticky
  sessions at Traefik. The Redis adapter makes rooms span replicas; it does not make a handshake
  split across two of them work.

---

## Tests

```bash
npm test            # unit: the scoring engine and pricing maths, no I/O
npm run test:cov    # the scoring module is held at 100%
npm run test:e2e    # integration, against real Postgres and Redis
npm run check:knip  # dead code and unused dependencies
```

The e2e suite starts its own Postgres and Redis containers, builds the schema from the entities and
installs the fixture catalogue in `test/support/catalogue-fixture.ts` — so it never touches your
local database, and it behaves the same on CI as on a laptop. Nothing is mocked: the behaviours worth testing here (a partial unique index, a
pessimistic lock, a Redis-backed socket room) live below the layer a mock would replace.

`test/head-to-head.e2e-spec.ts` boots **two** applications against one Postgres and one Redis, and
asserts across the gap. That is the only way to catch the failure where a match works perfectly in
one process and goes silent the moment a load balancer puts the two players on different pods.

---

## How it fits together

```
src/
  common/        serialization, filters, guards, the socket adapter
  config/        env schema (Joi) and typed namespaces
  database/      the schema extras `synchronize` cannot express
  health/        Terminus probes
  modules/
    auth/        anonymous device auth, dual-secret JWTs
    users/       profile, username claim, streaks
    catalog/     themes, items, the slider draw, and the `items/` import
    currency/    live exchange rates, and the one place a dollar becomes a euro
    daily/       the deterministic daily draw
    sessions/    the transactional game loop
    scoring/     the scoring engine — pure, versioned, no I/O
    leaderboard/ Postgres authoritative, Redis serving
    friends/     owns the friendship table the friends board reads
    matches/     head-to-head, over sockets
    notifications/ push tokens and the evening nudge
    home/        one call, one screen
    jobs/        BullMQ repeatable jobs, and the boot-time catalogue import
items/         the catalogue itself — one folder per category, one file per item
```

A few decisions worth knowing before you change something:

**Scheduling is BullMQ, not `@Cron()`.** `@Cron()` fires on _every_ replica, so with three pods
you would generate tomorrow's challenge three times. `upsertJobScheduler` is keyed on a stable
scheduler id, so N replicas converge on one entry and exactly one worker claims each tick.

**The leaderboard is two stores on purpose.** `daily_score` in Postgres is the source of truth;
Redis ZSETs serve ranks and percentiles in O(log n). Postgres is written first, so a Redis blip
costs latency and never scores — `leaderboard-rebuild` reconstructs the ZSETs from the table. ZSET
members are zero-padded user ids so ties break deterministically — and because every read goes
through `ZREV*`, which reverses that order, Postgres matches it with
`ORDER BY score DESC, "userId" DESC`.

**The daily draw is a pure function of the date.** A seeded PRNG (mulberry32 over a SHA-256 of
`cashortrash:daily:<date>`) means two players — and two replicas — deal the same five items in the same
order, and the stored seed makes any past day auditable.

**The shot clock is the server's, and the client is never asked what time it is.** `GET
/sessions/:id/current` stamps `currentServedAt` once per round index — a re-fetch returns what is
_left_ of the ten seconds, never a fresh ten — and the bet endpoint compares `now()` against that
stamp plus `ROUND_SECONDS` and `ROUND_GRACE_MS`. A late bet is **recorded, not refused**: a 400
would strand the player on a round they could never legally clear, so the round is stored with
`timedOut = true`, zero points, and the server-measured `elapsedMs` that decided it. The one
remaining way out — betting on a round that was never dealt, and so has no stamp to measure — is a
400 whenever either the clock or `MIN_ROUND_SECONDS` is armed. See `SessionsService.roundClock`.

**Idempotency is in the schema, not in application logic.** `session_round`'s composite primary key
makes a replayed bet a unique-violation the service translates into the stored result; a partial
unique index on `(userId, dailyDate) WHERE mode = 'daily'` makes a second daily session impossible
rather than merely unlikely.

**One price per item, in dollars, whatever the player sees.** An item carries a single
`truePriceCents` and one pair of slider bounds, all USD, and the scoring engine only ever works in
those. `CurrencyService` converts on the way out and back again on the way in, so a euro round is a
presentation of the stored dollar price rather than a second price that could disagree with it —
adding a currency is a line in `currency.constants.ts`, not a repricing of the catalogue.

Two consequences follow. The slider grid is derived from the _converted_ bounds, so a euro round
snaps to round euro amounts and a bet placed on it is not on the dollar grid — which is why
`/current`, `/summary` take `?currency` and the bet body carries its own. And rates are live
(`ExchangeRatesService`, ECB via Frankfurter by default, refreshed hourly onto an in-memory
snapshot backed by Redis), so the grid can move between dealing a round and receiving its bet. The
bet endpoint therefore validates a non-dollar bet against the bounds with a stop of slack and
clamps rather than demanding an exact stop: rejecting an honest bet for a market move the player
never saw would be a bug, and an unsnapped bet scores no differently from the stop beside it.

**Reactions to a bet happen after the commit.** Leaderboard writes and opponent pushes are domain
events, so `placeBet` does not know the leaderboard exists. The consequence is that those writes
land microseconds _after_ the response returns — see `test/support/wait.ts`.

**Handles are filtered by a package, not by a word list.** `UsernameService` runs `obscenity`'s
English dataset with its recommended transformers, which see through leetspeak, confusables and
repeated letters — so `sh1thead` and `fvck` are caught, and `classiccars`, `bassmaster` and
`assistant` are not, which a substring list gets wrong. Separators are collapsed before matching
(`f.u.c.k`), and `ADDITIONAL_BLOCKED_SUBSTRINGS` holds only the slurs the dataset does not carry.
Rejections travel as stable problem `type` slugs — `username-invalid`, `username-not-allowed`,
`username-taken` — because the client switches on those and must never parse the prose. Reserved
and profane share one code deliberately: naming the filter someone tripped tells them how to get
the next variation past it.

---

## Configuration

Every variable is validated at boot by `src/config/env.validation.ts`; a missing or malformed one
fails the process immediately rather than surfacing three requests later. See `.env.example` for
the full set. The ones with teeth:

| Variable                                   | Notes                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Must differ. Separate secrets plus a `typ` claim mean a refresh token can never be replayed as an access token.                     |
| `ROUNDS_PER_SESSION`                       | Five, per the design. Changing it changes the daily draw size.                                                                      |
| `ROUND_SECONDS`                            | The shot clock: seconds a player has once the round is dealt. Timed by the server, from its own stamp. `0` disables it.             |
| `ROUND_GRACE_MS`                           | Slack on that deadline, covering the flight of a bet placed at zero. Not spendable as thinking time — the client counts to zero.    |
| `MIN_ROUND_SECONDS`                        | Anti-scripting floor on time spent per round. `0` disables it. Must be below `ROUND_SECONDS`, or no bet could ever be placed.       |
| `THROTTLE_LIMIT`                           | Redis-backed, so limits hold across replicas rather than per-process.                                                               |
| `CURRENCY_API_URL`                         | Live exchange rates, base USD. Defaults to the ECB's daily reference rates via Frankfurter, which needs no key.                     |
| `CURRENCY_FALLBACK_RATE_*`                 | Not rates — the floor under them, used only before the first fetch lands or when the provider is down with nothing cached.          |
| `ITEMS_ROOT`                               | Where the catalogue tree lives. Empty resolves next to the compiled output, which is where the image puts it — normally leave it unset. |
| `IMPORT_ON_BOOT`                           | Whether a deploy imports the tree it shipped with. Off boots a replica that serves the catalogue without writing to it.             |
| `MEDIA_ROOT`                               | Where washed item photographs are written. A named volume in production; NOT covered by the database backup — `db-backup` tars it separately. |
| `OPENAI_API_KEY` / `OPENAI_MODEL`          | Writes every title and description in the catalogue. **Required** while `IMPORT_ON_BOOT` is true — boot validation refuses the combination rather than importing raw filenames. |

---


## The catalogue is `items/`

The directory tree *is* the content. A folder is a category, a file is an item,
and the price is in US dollars:

```
items/
  electronics/
    icon.txt                        → "gem"   (one of the seven glyphs the app ships)
    aula f99 pro keyboard_78.jpg
    yubikey 5_75.jpg
  watches/
    icon.txt                        → "gem"
    rolex daytona 2016_20600.webp
```

**Adding items is a file drop and a redeploy.** The import runs on boot, reads
the tree baked into the image, and does real work only for files it has not seen
before. There is no separate command, no manifest to review, and no admin panel
— `items/` is the only way in.

Adding a *category* is the same: make a folder, put an `icon.txt` in it, add
images. It appears in the picker once it holds `ROUNDS_PER_SESSION` items, since
a category that cannot deal a full round is not offered.

### What the job does per file

1. **Parse the filename**, splitting on the *last* underscore — a description may
   contain one, and `cessna 150_1967_82500.jpg` is a 1967 Cessna 150 at $82,500.
2. **Hash the raw bytes.** If an item already carries that `sourceHash` under the
   same name, stop: nothing is decoded, nothing is written, and no model is
   called. This is the path a redeploy takes for everything already present.
3. **Wash and crop** the photograph to 5:4 through `ImageProcessor` and
   `MediaStore`, content-addressed by digest.
4. **Write the title and description** with `ItemCopywriter`. See below.
5. **Insert**, keyed on the hash.

Anything whose file has disappeared is deactivated, so deleting an image stops it
being dealt. Deactivated rather than deleted, because `session_round` references
items with `onDelete: RESTRICT` — a scoreboard must not lose the round it was
built from.

**Identity is the image, not the title.** The copywriter rewrites titles, so
keying on one would make every deploy look like a catalogue of brand-new items.
Hashing the *source* bytes rather than the washed derivative also means a sharp
upgrade does not silently re-import everything.

**Renames are cheap and meaningful.** Correcting a price re-reads the number and
leaves the prose alone; changing the descriptive half re-runs the copywriter.
Neither creates a second row.

**An item under $20 is refused.** A slider needs a $1 floor and enough travel to
be worth dragging, and below roughly $20 no draw can give both — so the
catalogue never holds an item that deals a broken round every time it appears.
Rejections are logged individually at boot: a rejected item is a hole in a
category, and enough of them drop it under the count the picker needs.

### The copywriter never sees a price

`ItemCopywriter` is given the filename text and the category, and returns the
title and the line under the photograph. It is **never given the price** — that
is what stops it writing "a bargain at this price" and handing the player the
answer.

Prompting alone is not enough, because the model can leak from what it already
knows about the object: "one of the most valuable cards ever printed" gives the
game away without containing a number. So both fields are filtered on the way
out for currency amounts, value judgements, desirability claims, market
references and tier words. A field that leaks or overruns its column is
rejected, and the item keeps the text its filename gave it.

Nothing here can fail a deploy. A refusal, a truncated response, or an
unreachable API costs prose, not the catalogue.

### Icons are a closed set

`icon.txt` must name one of `basket`, `camera`, `gem`, `house`, `shuffle`,
`calendar`, `pencil`. Not for our convenience: Metro does not tree-shake, so the
app imports each Lucide glyph by name at build time and ships only those. A name
it has never heard of renders as the fallback, silently — so an unknown one is a
loud warning at deploy time instead. A warning and not a failure, because a
mistyped glyph should not hold the whole catalogue hostage.

**Adding an eighth glyph is a two-sided change, and the app ships first:** add
the import and map row in the app's `Icon.tsx`, release it, *then* add the name
to `THEME_ICONS`. The other order points live cards at a glyph the installed
builds do not have. It is why cars, boats and planes currently borrow `shuffle`.

### Where it runs

On the BullMQ maintenance queue, enqueued once per boot — not in the boot path.
`make deploy` smoke-tests `/health/ready`, and a cold import that washes fifty
photographs and calls a language model in between would hold readiness open long
enough to look like a failed deploy.

The processor takes a Postgres advisory lock, so exactly one replica imports.
The queue's job id collapses simultaneous boots into one entry, but that is a
convenience: a completed job eventually falls out of `removeOnComplete`, and the
lock is the actual guarantee. It also walks files strictly one at a time — sharp
decodes outside the V8 heap where `--max-old-space-size` cannot see it, so
concurrency here would multiply the peak the cgroup is watching.

---

## Slider bounds are drawn per round

The bounds are **not stored on the item**. They are drawn when the round is
dealt, so an object a player has met before does not come back on the scale they
remember. `src/modules/catalog/slider.ts` owns this.

### The seed is the shared-fate scope

Which is the whole decision, because the seed is what decides fairness:

| Mode | Seed | Why |
|---|---|---|
| `daily` | `daily:<date>:<itemId>` | Same items for everyone, one attempt each, one leaderboard. Two players on different scales for the same object are not playing the same game — and the board would rank them anyway. |
| `h2h` | `match:<matchId>:<itemId>` | Both players must face the same rounds; that is the premise of a match. |
| `quick` | `session:<sessionId>:<itemId>` | Nobody is being compared, so the item genuinely plays differently every time. |

Everything that reads the bounds goes through one helper, because they are
consulted three times on the way through a round — dealing it, clamping the bet,
scoring it — and a bet clamped on one scale but scored against another is a
wrong answer nobody would ever see.

One consequence worth knowing when writing tests: two *quick* sessions on the
same item are deliberately not comparable. `currency.e2e-spec.ts` plays the
daily for exactly that reason.

### Random on both axes, on purpose

A slider has two degrees of freedom a player can learn: **where** the answer
sits along the travel, and **how wide** the travel is relative to the answer.
Either one being predictable is a price leak — an indirect one, but a player who
knows the shape guesses well while knowing nothing about the object. So both are
sampled directly and neither is left to fall out of the other.

That is worth stating because it is easy to get wrong twice. Drawing the
*bounds* and letting position fall out pins the answer at 20–30% of the travel
almost every time (a slider cannot start below zero, so a wide band always
leaves the answer low). Fixing that by drawing *position* and letting width fall
out makes width a ratio of two uniforms, which is not uniform either — two
rounds in three came out within a third of 1.7×.

The fix is to draw one axis freely and fit the other into what remains feasible,
alternating which goes first (60/40, favouring position — it is the axis a fixed
anchor actually exploits). One coupling is arithmetic rather than taste: the
floor may not drop below a tenth of the answer, so a wide span cannot also put
the answer near the top.

The spec asserts on both, against the floor a perfectly uniform draw would give:

| | best fixed guess | uniform floor | naive derivation |
|---|---|---|---|
| position anchor | ~28% | ~15% | 39% |
| width cluster | ~56% | ~35% | 68% |

The residual gap is the rounding ladder — a deliberate trade for bounds that
read like numbers a person chose (`$30,000 .. $200,000`, not `$28,412 ..
`$196,304`).

### Why the copy is written rather than templated

The title and `conditionLine` are the only prose a player gets — title,
photograph, condition line, slider — so they are what the object is priced from.
"2005 · used" makes the round a coin flip on whether the title is recognised.

**The hard constraint is that neither may leak the price.** Both are shown before
the guess, so "one of the most sought-after Rolexes ever made" hands over the
answer as surely as printing the number would. That is why the model is never
shown the price, why the prompt forbids appraisal, and why `findPriceLeak`
filters both fields on the way out. Scarcity as a specification ("one of 400
built") passes; scarcity as an appraisal ("very rare") does not.

The filter covers the title too, which it did not have to before: the title used
to come from a lookup table and could not leak. Now that a model writes it,
"Rare Black Lotus" is exactly as much of a giveaway as it would be in the line
below.

The model is `OPENAI_MODEL` (default `gpt-5.4`) — the task is short and tightly
specified, so a mid-tier model usually reads as well as a larger one; raise it
if the lines come back generic. A rejected field falls back to what the filename
said, normalised through a small table of marques and abbreviations.

---

## The cache manifest

`GET /v1/manifest` publishes one opaque version per resource a client keeps on
disk:

```json
{ "catalog": "b3f1c0a92d4e77aa", "currency": "7c21ab90ff3d1e64" }
```

A client stores the version each resource was last fetched at, polls this on
launch and foreground, and refetches only the ones that moved. The strings mean
nothing beyond *same* or *different* — clients must not parse them.

**This exists because the app persists its theme list.** That is what lets the
picker open instantly and work offline, and it is also what lets a build show a
catalogue the server has already replaced. A `staleTime` cannot fix that: it is
a guess made in the client about how long the server stays still, wrong in both
directions — too long and a category nobody can play sits on the picker, too
short and every launch refetches a list that changes weekly. This replaces the
guess with an answer.

**A version is a digest of the exact payload the resource would return**
(`digestOf`), not a counter bumped on write. That is the only scheme that cannot
drift: there is no write path to remember, and no way to change what a client
sees without changing the version. It also means the version *returns* to its
old value when a change is undone, which is what makes "unchanged" as
trustworthy as "changed" — a monotonic counter would send every client to
refetch a picker identical to the one it already holds.

Two consequences worth knowing:

- **The payload must be deterministic.** A response that embeds a timestamp, or
  orders rows without a tiebreak, changes its digest on every call and turns the
  manifest into a refetch-always instruction. `listThemes` orders by
  `(isMystery, sortOrder, id)` for exactly this reason.
- **`catalog` moves more often than "a category appeared".** The mystery row
  carries a count of the whole catalogue, so every item added or removed is
  visible on the picker somewhere. That is the version tracking the payload
  exactly, not an over-eager trigger.

Adding a resource is a field on `CacheManifestDto` plus a digest of whatever it
versions — and, on the app side, an entry in `MANIFEST_QUERY_KEYS`. A client
that does not know a field ignores it, so the server can start versioning
something before the app ships code that caches it.

---

## Item photography

Photographs come off disk, from `items/`. `ImageProcessor` rejects and resizes them and
`MediaStore` writes the result under its own SHA-256 digest, so an item points at
`/media/items/<digest>.webp` — bytes this application owns. Nothing is fetched over HTTP any more;
the URL-pasting path went with the admin panel.

The whole path lives in `modules/media/`. Notable properties:

- **Every derivative is 5:4.** `ItemPhoto` renders into a fixed-height, full-width card with
  `cover`, so something crops either way; doing it here makes it `attention` rather than a blind
  centre crop, and inspectable because the result is a stored file. Note that sharp's
  `withoutEnlargement` does *not* achieve this on its own — combined with `cover` it declines to
  resize a source smaller than the target box and hands back the original shape, which is most of
  this catalogue. `cardBox` computes the largest 5:4 box the source can fill instead, so nothing is
  upscaled and nothing keeps the wrong shape.
- **The size floor is on the card, not the source.** `MIN_CARD_HEIGHT` (384px, the shortest card
  already shipping) is checked against what the crop produces. A floor on the source's shorter edge
  was a fair proxy until the output became landscape, and then stopped being one: a portrait
  500×610 cleared a 450px floor and made a 500×400 card, while a landscape 480×400 failed it and
  would have made 480×384 — two cards a player cannot tell apart, decided by which way round the
  camera was held.
- **A rejected photo is a rejected item.** An image under the `MIN_CARD_HEIGHT` floor, an animated GIF or
  undecodable bytes are logged individually and the item is not imported — a hole in a category,
  which is why the log lists every one.
- **Bounded before it is decoded.** `ImageProcessor` rejects on the *declared* pixel
  dimensions before sharp decodes anything, with a 40 MP backstop. This matters because sharp
  decodes outside the V8 heap where `--max-old-space-size` cannot see it — see the note on the
  `mediadata` mount in `docker-compose.prod.yaml`.
- **Content-addressed, so writes are safe from more than one process.** The digest is the content,
  so two writers racing on a path are writing identical bytes.

---

## Known gaps

- **The catalogue is 62 items across nine categories, and three of those categories cannot be
  offered.** Seven images are genuinely too small — all five apartments (360×265) and the lego
  Liberty Statue (270×270) crop to cards under 300px tall, and `electronics/ledger` (400×400) makes
  a 400×320. That leaves apartments empty, and electronics (4) and lego (3) under
  `ROUNDS_PER_SESSION`; trading cards sits exactly on five. **Better source photographs are the
  only real fix.** Upscaling to clear the floor is measurably counterproductive — Lanczos to 450px
  drops detail-per-pixel below what is already shipping, because it adds pixels rather than
  information. AI super-resolution would genuinely add plausible detail, but belongs in a one-off
  content pass committed to `items/`, never in the import: it is non-deterministic, and the whole
  reason a redeploy is cheap is that a photograph's bytes hash to the same thing twice.
  The rejections are listed individually in the boot log every deploy.
- **Push delivery is a stub.** Tokens are registered and the nudge job buckets them by timezone,
  but `PushSender` still logs instead of sending. The provider is decided — **Expo push**, which
  needs no certificates — so closing this is one `PushSender` implementation and a config key, with
  nothing above that abstraction to change.
- **There is no way to fix one row without a redeploy.** The admin panel and the MCP server were
  removed in favour of `items/` being the only way in, which means correcting a title the model got
  wrong is a file rename and a deploy. That is the intended trade — the price never passes through
  the model, so the failure mode is prose rather than an unwinnable round — but it is a real
  reduction in what can be repaired live.
- **No migrations, by design.** Every environment builds its schema from the entities on boot via
  `DATABASE_SYNCHRONIZE`, which means a deploy can drop anything the entities do not describe and
  the pre-deploy dump is the only rollback. See [Schema changes](#schema-changes) — this is the
  gap to understand before running this in production, not a step someone forgot.
