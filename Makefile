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
