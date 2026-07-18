# ---- web build ----
FROM node:22-slim AS webbuild
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
# The dashboard imports domain types from the root via the @keeper/types alias
# (../src/types.ts) — the file must exist in this stage for tsc to pass.
COPY src/types.ts /app/src/types.ts
COPY web/ ./
RUN npm run build

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/
COPY docs/ docs/
COPY --from=webbuild /app/web/dist web/dist
# Recordings are baked read-only; the entrypoint seeds them into the (possibly
# volume-mounted) data dir so replay works with or without a persistent volume.
COPY data/ data-baked/
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 8790
ENV PORT=8790
CMD ["./docker-entrypoint.sh"]
