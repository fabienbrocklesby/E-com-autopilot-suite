# ─── Development stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS development

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# ─── Build stage ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# PUBLIC_API_BASE_URL is baked into the JS bundle at build time by SvelteKit's
# $env/static/public. It must be passed as a build arg: --build-arg PUBLIC_API_BASE_URL=...
ARG PUBLIC_API_BASE_URL
ENV PUBLIC_API_BASE_URL=$PUBLIC_API_BASE_URL

COPY package.json ./
RUN npm install

COPY . .
# Cap Node heap to 1024xw MB to prevent OOM kills on low-memory VPS servers.
RUN NODE_OPTIONS="--max-old-space-size=1024" npm run build

# ─── Production stage ───────────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodegroup && \
	adduser --system --uid 1001 --ingroup nodegroup nodeuser

COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

RUN chown -R nodeuser:nodegroup /app
USER nodeuser

EXPOSE 3000

ENV NODE_ENV=production
CMD ["node", "build"]
