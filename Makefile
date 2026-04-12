.PHONY: dev build down logs db-migrate db-shell api-shell lint fmt test setup

# First-time setup: copy env example if .env doesn't exist
setup:
	@if [ ! -f .env ]; then cp .env.example .env && echo "✓ .env created from .env.example — fill in your values before running make dev"; else echo ".env already exists"; fi

# Start the full stack and follow logs
dev:
	docker compose up --build -d
	docker compose logs -f

# Build all containers without starting them
build:
	docker compose build

# Stop and remove containers, networks (keeps volumes)
down:
	docker compose down

# Follow logs for all services
logs:
	docker compose logs -f

# Run pending database migrations inside the running api container
db-migrate:
	docker compose exec api deno run \
		--allow-net \
		--allow-env \
		--allow-read \
		db/migrate.ts

# Open a psql shell in the postgres container
db-shell:
	docker compose exec postgres psql -U $${PGUSER:-emaildash} -d $${PGDATABASE:-emaildash}

# Open an interactive shell in the api container
api-shell:
	docker compose exec api sh

# Run deno lint on the api source
lint:
	docker compose exec api deno lint

# Run deno fmt on the api source
fmt:
	docker compose exec api deno fmt

# Run deno test on the api source
test:
	docker compose exec api deno test --allow-net --allow-env --allow-read

# ─── One-time setup: Pub/Sub push subscription ──────────────────────────────────
# Run this ONCE after first clone, or whenever you change NGROK_DOMAIN.
# It creates (or overwrites) the Gmail push subscription pointing at your tunnel.
# Requires: gcloud CLI authenticated + PUBSUB_TOPIC / NGROK_DOMAIN in .env
#
# Usage: make setup-pubsub
setup-pubsub:
	@set -a; . ./.env; set +a; \
	SUBSCRIPTION_NAME=$$(echo $$PUBSUB_TOPIC | sed 's|topics/|subscriptions/|')-sub; \
	PUSH_ENDPOINT="https://$$NGROK_DOMAIN/webhooks/gmail"; \
	echo "→ Topic:        $$PUBSUB_TOPIC"; \
	echo "→ Subscription: $$SUBSCRIPTION_NAME"; \
	echo "→ Push endpoint:$$PUSH_ENDPOINT"; \
	if gcloud pubsub subscriptions describe $$SUBSCRIPTION_NAME --format='value(name)' 2>/dev/null | grep -q $$SUBSCRIPTION_NAME; then \
		echo "→ Subscription exists — updating push endpoint…"; \
		gcloud pubsub subscriptions modify-push-config $$SUBSCRIPTION_NAME \
			--push-endpoint="$$PUSH_ENDPOINT"; \
	else \
		echo "→ Creating subscription…"; \
		gcloud pubsub subscriptions create $$SUBSCRIPTION_NAME \
			--topic="$$PUBSUB_TOPIC" \
			--push-endpoint="$$PUSH_ENDPOINT" \
			--ack-deadline=30; \
	fi; \
	echo ""; \
	echo "✓ Done. Add this to .env if not already set:"; \
	echo "  PUBSUB_SUBSCRIPTION=$$SUBSCRIPTION_NAME"
