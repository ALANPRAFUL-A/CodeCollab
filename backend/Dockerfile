# =============================================================================
# CodeCollab backend - Express + Socket.IO + Yjs
# =============================================================================
# Multi-stage build. The point of the split is that `npm ci` (slow, needs the
# lockfile only) lands in its own cached layer, so editing server.js rebuilds in
# about a second instead of re-resolving the whole dependency tree.
#
# node:24-alpine matters for one specific reason: NODE_USE_ENV_PROXY (which makes
# built-in fetch honour HTTP_PROXY/HTTPS_PROXY/NO_PROXY) requires Node >= 22.21
# or >= 24.5. That is how the container reaches the Squid forward proxy.
# =============================================================================

# ---------- Stage 1: install production dependencies ----------
FROM node:24-alpine AS deps

WORKDIR /app

# Only the manifests, so this layer is invalidated only when deps change.
COPY package.json package-lock.json ./

# `npm ci` installs the exact lockfile tree - reproducible, unlike `npm install`.
# --omit=dev keeps devDependencies out of the runtime image.
RUN npm ci --omit=dev && npm cache clean --force


# ---------- Stage 2: runtime ----------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0 \
    NODE_USE_ENV_PROXY=1

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# Never run as root. The official node image ships an unprivileged `node` user.
USER node

EXPOSE 5000

# Docker's own liveness signal. This is independent of the HAProxy health check:
# Docker restarts a dead container, HAProxy removes an unhealthy one from
# rotation. /health returns 503 when MongoDB is unreachable, so both react to it.
# wget comes from busybox, so no extra package to install.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

# `node server.js` directly, not `npm start`: npm would sit in the middle as PID 1
# and swallow SIGTERM, breaking the graceful shutdown that flushes Yjs documents.
CMD ["node", "server.js"]
