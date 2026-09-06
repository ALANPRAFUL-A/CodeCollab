# =============================================================================
# CodeCollab frontend - React + Vite, served as static files by nginx
# =============================================================================
# A React SPA has no server-side runtime. `vite build` produces plain files in
# dist/, so the runtime image is nginx with ~3 MB of assets - no Node, no npm, no
# source code. That is roughly 40 MB instead of 1.2 GB, and a much smaller attack
# surface because there is no interpreter in the final image.
# =============================================================================

# ---------- Stage 1: build the bundle ----------
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
# Full install here (not --omit=dev): vite and the react plugin ARE devDependencies
# and are required to produce the bundle.
RUN npm ci

# CRITICAL: Vite inlines import.meta.env.* at BUILD time, so this must be a build
# ARG, not a runtime environment variable. You cannot change the backend URL of an
# already-built image without rebuilding.
#
# The default is deliberately EMPTY, which src/config.js interprets as "same
# origin". That routes every request through the nginx reverse proxy, so the
# HAProxy sticky cookie works and there is no CORS at all.
# Only override this for a split-origin deploy (e.g. Vercel + Render).
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

COPY . .
RUN npm run build


# ---------- Stage 2: serve ----------
FROM nginx:1.27-alpine AS runtime

# SPA routing + asset caching rules. See frontend/nginx.conf.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Only the compiled output crosses the stage boundary.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/nginx-health || exit 1

CMD ["nginx", "-g", "daemon off;"]
