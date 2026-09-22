COMPOSE := docker compose -f docker-compose.prod.yml
COMPOSE_DEV := docker compose -f docker-compose.local.yml

.PHONY: help dev dev-deps dev-down dev-logs up down restart deploy build smoke pull logs ps psql redis-cli sh status health prune db-backup db-restore queue-failed queue-clean-failed

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

dev: ## Start the whole local stack with hot-reload (foreground)
	$(COMPOSE_DEV) up

dev-deps: ## Start only Postgres and Redis, for `npm run start:dev` on the host
	$(COMPOSE_DEV) up -d postgres redis

dev-down: ## Stop and remove the local stack
	$(COMPOSE_DEV) down

dev-logs: ## Tail logs from the local stack
	$(COMPOSE_DEV) logs -f --tail=200

up: ## Start the prod stack in the background
	$(COMPOSE) up -d

down: ## Stop and remove containers (volumes preserved)
	$(COMPOSE) down

restart: ## Restart all services
	$(COMPOSE) restart

pull: ## Pull updated images for the pinned tags
	$(COMPOSE) pull

build: ## Rebuild the app image
	$(COMPOSE) build app

# Back up before recreating. Migrations never run backward automatically, so
# this pair is the rollback point if a release has to be reversed.
deploy: ## Pull, rebuild, back up, recreate changed services, smoke
	git pull --ff-only
	$(MAKE) build
	$(MAKE) db-backup
	$(COMPOSE) up -d --remove-orphans
	$(MAKE) smoke

smoke: ## Check public readiness
	@set -a; . ./.env; set +a; \
	for attempt in $$(seq 1 40); do \
		if curl --connect-timeout 3 --max-time 10 -fsS "https://$$DOMAIN/health/ready" >/dev/null 2>&1; then \
			echo "Smoke check passed for https://$$DOMAIN/health/ready"; \
			exit 0; \
		fi; \
		sleep 3; \
	done; \
	echo "Smoke check failed for https://$$DOMAIN/health/ready"; \
	curl --connect-timeout 3 --max-time 10 -v "https://$$DOMAIN/health/ready" || true; \
	exit 1

logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=200

ps: ## Show service status
	$(COMPOSE) ps

status: ps ## Alias for ps

health: ## Show health status of each service
	@$(COMPOSE) ps --format 'table {{.Service}}\t{{.Status}}'

db-backup: ## Take an immediate pg_dump into ./backups (on top of the daily one)
	$(COMPOSE) run --rm --entrypoint /bin/sh db-backup /db-backup.sh once

MEDIA ?= $(dir $(FILE))media-$(patsubst cashortrash-%.dump,%,$(notdir $(FILE))).tar.gz

db-restore: ## Overwrite DB + media from a pair: make db-restore FILE=backups/<name>.dump
	@test -n "$(FILE)" || { echo "usage: make db-restore FILE=backups/cashortrash-<timestamp>.dump"; exit 1; }
	@test -f "$(FILE)" || { echo "$(FILE) not found"; exit 1; }
	@test -f "$(MEDIA)" || { echo "matching media archive $(MEDIA) not found"; exit 1; }
	@printf 'This OVERWRITES the live database and media with %s. Type yes to continue: ' "$(FILE)"; \
	read ans; [ "$$ans" = yes ] || { echo "aborted"; exit 1; }
	$(COMPOSE) stop app
	$(COMPOSE) exec -T postgres sh -c 'pg_restore -U $$POSTGRES_USER -d $$POSTGRES_DB --clean --if-exists --no-owner' < $(FILE)
	$(COMPOSE) run --rm --no-deps -v ./backups:/restore:ro --entrypoint /bin/sh app -c 'find /var/lib/cashortrash/media -mindepth 1 -delete; tar -xzf /restore/$(notdir $(MEDIA)) -C /var/lib/cashortrash/media'
	$(COMPOSE) start app
	$(MAKE) smoke

psql: ## Open a psql shell against the prod database
	$(COMPOSE) exec postgres sh -c 'psql -U $$POSTGRES_USER -d $$POSTGRES_DB'

redis-cli: ## Open redis-cli against the prod redis
	$(COMPOSE) exec redis redis-cli

sh: ## Shell into the running app container
	$(COMPOSE) exec app sh

# Readiness fails for 24h after any maintenance job exhausts its retries (see
# src/health/queue.health.ts). Once the cause is understood and fixed, this
# clears the alarm without waiting out the window. Read `queue-failed` first:
# the failed set is the only record of what went wrong, and this deletes it.
# Run inside the app container so it uses the app's own BullMQ and Redis
# settings rather than a second copy of them here.
QUEUE_NODE = $(COMPOSE) exec -T app node -e 'const {Queue}=require("bullmq"); \
	const q=new Queue("maintenance",{connection:{host:process.env.REDIS_HOST,port:Number(process.env.REDIS_PORT||6379), \
	password:process.env.REDIS_PASSWORD||undefined,db:Number(process.env.REDIS_DB||0)}});

queue-failed: ## List the most recent failed maintenance jobs and why
	$(QUEUE_NODE) q.getFailed(0,19).then((jobs)=>{for(const j of jobs)console.log(new Date(j.finishedOn||j.timestamp).toISOString(),j.name,j.id,"attempts="+j.attemptsMade,j.failedReason);return q.close();}).catch((e)=>{console.error(e);process.exit(1);});'

queue-clean-failed: ## Delete every failed maintenance job, clearing the readiness alarm
	$(QUEUE_NODE) q.clean(0,100000,"failed").then((ids)=>{console.log("Removed "+ids.length+" failed job(s)");return q.close();}).catch((e)=>{console.error(e);process.exit(1);});'

prune: ## Remove dangling images and stopped containers
	docker system prune -f
