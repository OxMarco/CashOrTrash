# Pinned to the Node major that `@types/node` targets and that `.nvmrc` names:
# `lts` silently jumps majors when a new LTS line is promoted, so a routine
# rebuild could move the runtime unexpectedly. 24 is the current Active LTS
# (Krypton, supported to April 2028); 22 is maintenance-only and 20 went out of
# support in April 2026.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
# The Nest CLI rewrites the `src/*` path alias to relative requires as it
# compiles, so `dist` needs no runtime resolver hook. Worth knowing before
# swapping the build for plain `tsc`, which would not.
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
# Production dependencies only. `typeorm` is among them because it is the ORM
# the app runs on — not for its CLI, which nothing invokes: the schema is
# applied from the entities on boot and there is no migration step to run here.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist
# The placeholder item photo, resolved relative to `dist`. Its sha256 is what
# an item with no photograph carries in `item.photoUrl`, so without this every
# such item in the catalogue 404s its image.
COPY --chown=node:node assets ./assets
# The catalogue itself. This is the delivery mechanism: the import job reads
# this tree on boot, so adding items is a matter of committing files here and
# redeploying. Already-imported images are recognised by content hash and cost
# nothing on the next deploy.
COPY --chown=node:node items ./items

# sharp ships its libvips binaries as optional *dependencies*, not install
# scripts, so `--ignore-scripts` above does not skip them. Proving that at build
# time rather than on the first ingest job: a broken binary should fail the
# build, not the queue.
RUN node -e "require('sharp')"

USER node
EXPOSE 3000

# Liveness, not readiness: this answers "is the process wedged". Pointing it at
# /health/ready would let a Postgres blip restart every replica at once, turning
# a degraded service into no service. Probes sit outside the /v1 prefix.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
