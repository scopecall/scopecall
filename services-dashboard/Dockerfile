# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app

# Install only production-necessary system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# pnpm via corepack (bundled with Node 20+). Pinned via packageManager
# field below would be ideal, but we install a known-good version here
# so the build is reproducible without a packageManager pin.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Self-hosted image: Auth.js (credentials) is the auth provider.
# NEXT_PUBLIC_AUTH_PROVIDER is baked at build time — that's intentional.
# API URL is NOT baked: the proxy route reads INTERNAL_API_URL at request time.
ARG NEXT_PUBLIC_AUTH_PROVIDER=authjs
ENV NEXT_PUBLIC_AUTH_PROVIDER=$NEXT_PUBLIC_AUTH_PROVIDER

# Disable telemetry in CI / reproducible builds
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm run build

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

# Next.js standalone output (requires `output: "standalone"` in next.config.mjs)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# next.config.mjs `output: "standalone"` generates server.js at app root
CMD ["node", "server.js"]
