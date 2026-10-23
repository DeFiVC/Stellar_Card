# Multi-stage build for stellar_card-backend.
#
#   builder — installs dependencies (native toolchain confined here)
#   runner  — minimal production image, non-root, health-checked
#   base    — kept for the root docker-compose.yml (`target: base`)
#   dev     — hot-reload overlay for docker-compose.dev.yml
#
# The default (final) stage is `runner`, so a bare
# `docker build stellar_card-backend` produces the production artefact.

# Stage 1: builder
#
# better-sqlite3 is a native module, so the toolchain has to be present when
# `npm ci` runs. It is confined to this stage so the runtime image does not
# ship a C compiler.
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (e.g. better-sqlite3)
RUN apk add --no-cache python3 make g++ sqlite-dev

# Copy package descriptors
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy application source code
COPY src ./src
COPY jsconfig.json ./

# Create directory for SQLite database
RUN mkdir -p /app/data

# Stage 2: runner
#
# Minimal production image: only production dependencies, the application
# source, and a non-root user. Runs as uid 10001 rather than the stock
# `node` (1000) so the process is unprivileged and matches the deploy
# policy documented in the security review.
FROM node:20-alpine AS runner

ENV NODE_ENV=production \
    PORT=4000 \
    DB_PATH=/app/data/stellar_card.db

WORKDIR /app

RUN apk add --no-cache sqlite-libs tini \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S app -G app \
    && mkdir -p /app/data \
    && chown -R app:app /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/jsconfig.json ./

USER 10001

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]

# Stage 3: base
#
# Retained as an alias of the builder image so the root `docker-compose.yml`
# (`target: base`) and any out-of-tree consumers keep working unchanged.
FROM builder AS base

ENV NODE_ENV=production \
    PORT=4000 \
    DB_PATH=/app/data/stellar_card.db

EXPOSE 4000

CMD ["npm", "start"]

# Stage 4: Development
#
# Target this stage from docker-compose.dev.yml. It reuses the dependency
# layer above, then relies on a bind mount for `src/`, so an edit on the host
# restarts the server in the container without a rebuild.
#
# The CMD deliberately does not reuse the `dev` npm script: that script passes
# `--env-file=.env`, and Node exits non-zero when that file is missing. Under
# Compose the environment arrives from `environment:`/`env_file:` instead, and
# a developer who has not created a local `.env` should still get a working
# container.
FROM base AS dev

ENV NODE_ENV=development

CMD ["node", "--watch", "src/index.js"]
