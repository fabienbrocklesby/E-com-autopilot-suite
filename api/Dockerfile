# ─── Development stage ──────────────────────────────────────────────────────────
FROM denoland/deno:latest AS development

WORKDIR /app

# Install curl for the Docker healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Supports both build contexts:
# - repo root, used by docker-compose/Dokploy compose so root docs can be copied
# - api/, used by standalone API Dockerfile deployments
COPY . /tmp/build-context
RUN set -eux; \
	if [ -f /tmp/build-context/api/main.ts ]; then \
		cp -R /tmp/build-context/api/. /app/; \
		mkdir -p /app/docs; \
		cp /tmp/build-context/docs/PLAYBOOK_DESIGN_GUIDE.md /app/docs/PLAYBOOK_DESIGN_GUIDE.md; \
	else \
		cp -R /tmp/build-context/. /app/; \
	fi; \
	rm -rf /tmp/build-context

# Pre-cache all remote imports so they are baked into the image layer.
RUN deno cache main.ts

EXPOSE 8000

CMD ["deno", "run", "--watch", "--allow-net", "--allow-env", "--allow-read", "main.ts"]

# ─── Production stage ───────────────────────────────────────────────────────────
FROM denoland/deno:latest AS production

WORKDIR /app

# Install curl for the Docker healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --system --gid 1001 deno_group && \
	useradd --system --uid 1001 --gid deno_group deno_user

COPY . /tmp/build-context
RUN set -eux; \
	if [ -f /tmp/build-context/api/main.ts ]; then \
		cp -R /tmp/build-context/api/. /app/; \
		mkdir -p /app/docs; \
		cp /tmp/build-context/docs/PLAYBOOK_DESIGN_GUIDE.md /app/docs/PLAYBOOK_DESIGN_GUIDE.md; \
	else \
		cp -R /tmp/build-context/. /app/; \
	fi; \
	rm -rf /tmp/build-context
RUN deno cache main.ts

RUN chown -R deno_user:deno_group /app
USER deno_user

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
