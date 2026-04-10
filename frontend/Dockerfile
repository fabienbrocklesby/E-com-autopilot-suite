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

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

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
