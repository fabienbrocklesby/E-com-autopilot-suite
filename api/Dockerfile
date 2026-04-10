# ─── Development stage ──────────────────────────────────────────────────────────
FROM denoland/deno:latest AS development

WORKDIR /app

COPY deno.json .
COPY . .

# Pre-cache all remote imports so they are baked into the image layer.
RUN deno cache main.ts

EXPOSE 8000

CMD ["deno", "run", "--watch", "--allow-net", "--allow-env", "--allow-read", "main.ts"]

# ─── Production stage ───────────────────────────────────────────────────────────
FROM denoland/deno:latest AS production

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 deno_group && \
	adduser --system --uid 1001 --ingroup deno_group deno_user

COPY deno.json .
COPY . .
RUN deno cache main.ts

RUN chown -R deno_user:deno_group /app
USER deno_user

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
