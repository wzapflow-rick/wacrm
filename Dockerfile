# syntax=docker/dockerfile:1

# ============================================================
# ZapFlow CRM — production image (Next.js standalone)
# Runs on the VPS alongside Postgres, on the zapflow_network.
# ============================================================

# ---- deps: install production + build dependencies ----
FROM node:20-alpine AS deps
# libc6-compat: some native deps (e.g. pg internals) expect glibc symbols.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy only manifests first so this layer caches unless deps change.
COPY package.json package-lock.json* ./
# Use npm ci when a lockfile is present, otherwise fall back to install.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---- builder: compile the Next.js app ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next telemetry off in CI/build.
ENV NEXT_TELEMETRY_DISABLED=1
# Build the standalone server. Env vars needed only at runtime are NOT
# required here; anything read at build time must be provided as build args.
RUN npm run build

# ---- runner: minimal runtime image ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The app listens on 3000 inside the container.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Copy the standalone server, static assets, and public files.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# server.js is emitted by Next's standalone output.
CMD ["node", "server.js"]
