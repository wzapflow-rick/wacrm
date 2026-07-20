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

# ---- migrator: one-shot schema applier (run via the compose "migrate" profile) ----
# Reuses the full node_modules from `deps` (which includes pg) and adds only the
# SQL + the applier script, so `node db/apply.mjs` can bootstrap the CRM database
# over the private Docker network. Not part of the app runtime image.
FROM node:20-alpine AS migrator
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY db ./db
COPY supabase ./supabase
CMD ["node", "db/apply.mjs"]

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

# Liveness/readiness probe. Node 20 ships a global fetch, so we avoid needing
# curl/wget in the Alpine image. Exits 0 only when /api/health returns 2xx
# (app up + database reachable).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# server.js is emitted by Next's standalone output.
CMD ["node", "server.js"]
