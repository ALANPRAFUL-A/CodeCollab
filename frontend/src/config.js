/**
 * Single source of truth for where the backend lives.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old code duplicated this in AuthContext.jsx and Editor.jsx:
 *
 *   import.meta.env.VITE_API_URL || (import.meta.env.PROD
 *     ? "https://codecollab-ds87.onrender.com"
 *     : "http://localhost:5000")
 *
 * Two problems for a proxied deployment:
 *
 *  1. It is an ABSOLUTE origin, so the browser talks straight to the backend and
 *     completely bypasses the reverse proxy. The proxy, the load balancer and the
 *     sticky-session cookie all become dead weight.
 *  2. A different origin means every request is cross-origin, so you inherit CORS
 *     preflights and a hardcoded server-side allowlist you must keep in sync.
 *
 * The default is now an EMPTY STRING, meaning "same origin". `/api/auth/login`
 * resolves against whatever host served the page:
 *
 *   dev   -> http://localhost:5173  (Vite proxies /api and /socket.io to :5000)
 *   docker-> http://localhost:8080  (nginx routes /api and /socket.io to HAProxy)
 *
 * Same-origin also means the HAProxy sticky cookie is sent automatically, with
 * no CORS credentials dance.
 *
 * VITE_API_URL remains an escape hatch for split-origin deploys (Vercel frontend
 * + Render backend). Remember Vite inlines import.meta.env at BUILD time, so in
 * Docker it must be a build ARG, not a runtime env var.
 */

const raw = import.meta.env.VITE_API_URL ?? "";

/** "" = same origin. Otherwise an absolute origin with no trailing slash. */
export const API_BASE = raw.trim().replace(/\/+$/, "");

/**
 * socket.io-client treats `undefined` as "same origin as the page", which is
 * exactly what we want when API_BASE is empty. Do not pass "" here - the client
 * would try to parse it as a URL.
 */
export const SOCKET_URL = API_BASE || undefined;

/**
 * Socket.IO options.
 *
 * We intentionally keep the DEFAULT transports (HTTP long-polling, then upgrade
 * to WebSocket) rather than forcing ["websocket"]. Reasons:
 *
 *  - polling survives restrictive corporate proxies that block Upgrade
 *  - it is the realistic case that makes sticky sessions necessary, which is the
 *    whole point of the HAProxy `cookie SRVID` configuration
 *
 * withCredentials lets the sticky cookie ride along even if you later switch to
 * a cross-origin setup.
 */
export const SOCKET_OPTIONS = {
  withCredentials: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  timeout: 20000,
};

export const apiUrl = (path) =>
  `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
