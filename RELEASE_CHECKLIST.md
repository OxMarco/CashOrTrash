# Backend release checklist

Production is intentionally fail-closed. Do not weaken the checks below to make
a deployment pass; supply the real release inputs instead.

## Before the first production deploy

- [ ] Set `ADMIN_PASSWORD_HASH` from `npm run admin:hash` and an independent
  `ADMIN_JWT_SECRET`. Production refuses to boot without both. Confirm `/admin`
  is reachable, that a wrong password is refused, and that the attempt budget
  bites after ten failures from one address.
- [ ] If the release includes catalogue content, upload it through `/admin`.
  An empty catalogue is supported and does not affect readiness. Before
  uploading a photograph, satisfy yourself you have the right to publish it —
  nothing in the pipeline checks that, and every image is publicly reachable.
- [ ] Replace every example value in the production `.env`, including `DOMAIN`,
  `SUPPORT_EMAIL`, `ACME_EMAIL`, three independent auth and game secrets, and
  `OPENAI_API_KEY`.
- [ ] Set `POSTGRES_PASSWORD` in the production `.env`. `docker-compose.prod.yml`
  passes it to the postgres, app and db-backup services and refuses to start
  without it. Postgres only reads it when the data volume is first created: on
  a host whose volume already exists, either set it to the current password
  (`cashortrash` for volumes created before it was configurable) or change the
  password first with `make psql` → `ALTER USER cashortrash PASSWORD '…';`,
  then update `.env` and recreate `app` and `db-backup`.
- [ ] Set `APPLE_APP_ID` to the Apple Team ID plus the shipped bundle ID. Set
  `ANDROID_APP_PACKAGE` and the Play App Signing certificate's SHA-256
  fingerprint, not a local debug certificate.
- [ ] Point apex and optional `www` DNS records at the host before starting the
  stack so TLS issuance can succeed.
- [ ] Put an external uptime alert on `https://<domain>/health/ready`; container
  auto-healing is not an alert and cannot report a dead host.
- [ ] Decide how `./backups` leaves this host. The sidecar only writes daily
  dump + media pairs to local disk, so losing the host loses them with it —
  arrange an off-host copy (host-level snapshot, `scp`/`rsync` from elsewhere)
  and verify one landed.

## Release candidate

- [ ] Run `npm ci`, `npm run lint:check`, `npm run build`, `npm test --
  --runInBand`, `npm run test:e2e`, `npm run check:knip`, and
  `npm audit --omit=dev` on a machine with Docker running.
- [ ] Run `docker compose -f docker-compose.prod.yml config` with the real
  production environment and review the rendered image tags, domains, mounts,
  resource limits, and secrets references.
- [ ] Build the production image and scan it with the registry or host's image
  scanner before promotion.
- [ ] Restore the newest database dump and matching media archive into a
  disposable environment, then run the smoke check there. Never rehearse a
  restore against the live database.

## Deploy and verify

- [ ] Run `make deploy`, then confirm `make health` shows `app`, `postgres`,
  `redis` and `db-backup` healthy. `db-backup` only writes to `./backups` on
  this host; there is no off-site backup service in the stack, so confirm the
  off-host copy arranged above is still running separately.
- [ ] Confirm `/health/ready` reports the database, Redis and queue healthy.
  The public body carries only up/down per dependency; the reason is in the app
  log. The queue is down for 24h after any maintenance job exhausts its
  retries — `make queue-failed` shows which and why, and once the cause is
  fixed `make queue-clean-failed` clears it.
- [ ] Upload one item and confirm the copy job replaces its typed-in text with
  written prose in English, Spanish, Portuguese and Italian within a minute, and
  that no description mentions the price.
- [ ] Fetch `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json` from the public HTTPS hostname and compare the
  identifiers with the signed store builds.
- [ ] Request every URL the store listings point at and confirm each answers
  200, following redirects. App Review rejected 1.0.0 (2) under guideline 1.5
  over a Support URL of `/tos`, which this server has never served — the
  document is at `/terms`, and `/tos` now redirects there. The listing fields
  are the thing to check, not the routes: nothing in this repository fails when
  App Store Connect points somewhere that does not exist.

      for path in / privacy support terms tos; do \
        printf '%-9s ' "$path"; \
        curl -sL -o /dev/null -w '%{http_code} %{url_effective}\n' \
          "https://<domain>/$path"; \
      done

- [ ] Confirm the iOS **Support URL** in App Store Connect is
  `https://<domain>/support` and not the terms or privacy document. Guideline
  1.5 wants support information there — a terms page that returns 200 still
  fails it.
- [ ] Exercise anonymous sign-in, one quick game, one daily game, one
  head-to-head invite, push opt-in/unregister, and in-app account deletion on
  the deployed API.
- [ ] Confirm `/admin` is not indexable and that its API routes answer 401
  without a token — a player token included.
- [ ] Confirm a fresh dump and its matching media archive appear in `./backups`
  after deployment, then record the tested release SHA and rollback dump name.
