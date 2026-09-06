import dotenv from "dotenv";
dotenv.config();

import os from "os";
import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

import { connectDB, isDbHealthy, closeDB } from "./config/db.js";
import { createRedisClients } from "./config/redis.js";
import { setupEditorSocket } from "./sockets/editorSocket.js";
import { initYjsSync, flushAllDocs, getYjsStats } from "./services/yjsService.js";
import authRoutes from "./routes/authRoutes.js";

// ---------------------------------------------------------------------------
// Configuration - everything that differs between environments is an env var.
// The original code hardcoded the port and the CORS allowlist, which made the
// container unusable behind a proxy on a different origin.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || "0.0.0.0"; // must be 0.0.0.0 inside a container
const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname();
const STARTED_AT = Date.now();

const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const originCheck = (origin, callback) => {
  // No Origin header => same-origin navigation, curl, or a health probe.
  if (!origin) return callback(null, true);
  if (allowedOrigins.includes("*")) return callback(null, true);
  if (allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error(`CORS: origin ${origin} is not allowed`));
};

const app = express();

/**
 * Two proxies sit in front of us (nginx, then HAProxy), so req.ip and
 * req.protocol are only meaningful if we trust the X-Forwarded-* headers.
 * TRUST_PROXY defaults to 2 = "the two hops we control".
 */
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 2));
app.disable("x-powered-by");

app.use(cors({ origin: originCheck, credentials: true }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "2mb" }));

// Makes the load balancer's routing decision visible in the browser devtools.
app.use((req, res, next) => {
  res.setHeader("X-Served-By", INSTANCE_ID);
  next();
});

// ---------------------------------------------------------------------------
// Health / identity endpoints
// ---------------------------------------------------------------------------

/**
 * HAProxy polls this. Returning 503 when Mongo is unreachable is deliberate:
 * the load balancer then pulls this replica out of rotation instead of sending
 * users to a node that cannot persist their work.
 */
app.get("/health", (req, res) => {
  const dbUp = isDbHealthy();
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? "ok" : "degraded",
    instance: INSTANCE_ID,
    db: dbUp ? "up" : "down",
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    ...getYjsStats(),
  });
});

/** Refresh this through the proxy a few times to watch least-conn spread load. */
app.get("/api/whoami", (req, res) => {
  res.json({
    instance: INSTANCE_ID,
    clientIp: req.ip,
    forwardedFor: req.headers["x-forwarded-for"] ?? null,
    time: new Date().toISOString(),
  });
});

/**
 * Proves the forward proxy works. The backend network is `internal: true`, so
 * this request can ONLY succeed by going through Squid. Disabled by default.
 * There is no user-supplied URL here on purpose - that would be an SSRF hole.
 */
app.get("/api/egress-test", async (req, res) => {
  if (process.env.ENABLE_EGRESS_TEST !== "true") {
    return res.status(404).json({ message: "Not found" });
  }

  const target = "https://api.github.com/zen";
  const startedAt = Date.now();

  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "codecollab-egress-test" },
    });
    res.json({
      ok: response.ok,
      status: response.status,
      body: (await response.text()).slice(0, 200),
      viaProxy: process.env.HTTPS_PROXY || process.env.https_proxy || null,
      elapsedMs: Date.now() - startedAt,
      instance: INSTANCE_ID,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err.message,
      viaProxy: process.env.HTTPS_PROXY || process.env.https_proxy || null,
      hint: "If this times out, the forward proxy is not reachable or the host is not in allowed-domains.txt",
      instance: INSTANCE_ID,
    });
  }
});

app.use("/api/auth", authRoutes);

// 404 + error handler (Express 5 forwards async errors automatically)
app.use((req, res) => res.status(404).json({ message: "Not found" }));
app.use((err, req, res, next) => {
  const status = /^CORS:/.test(err.message) ? 403 : err.status || 500;
  if (status >= 500) console.error("[express]", err);
  res.status(status).json({ message: status >= 500 ? "Server error" : err.message });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: originCheck, methods: ["GET", "POST"], credentials: true },
  // Keep the defaults (polling then upgrade to websocket). The polling handshake
  // is exactly why the load balancer needs sticky sessions.
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: Number(process.env.MAX_UPDATE_BYTES) || 1_000_000,
});

/**
 * Socket.IO attaches its own listener to the HTTP server and handles /socket.io/
 * requests BEFORE Express middleware runs, so the app-level X-Served-By header
 * never applies to them. These two engine hooks are the documented way to add
 * response headers to the handshake and to subsequent polling requests.
 *
 * Practical value: you can watch which replica a tab is pinned to with
 *   curl -i "http://localhost:8080/socket.io/?EIO=4&transport=polling"
 * and confirm it matches the SRVID sticky cookie HAProxy handed out.
 */
io.engine.on("initial_headers", (headers) => {
  headers["X-Served-By"] = INSTANCE_ID;
});
io.engine.on("headers", (headers) => {
  headers["X-Served-By"] = INSTANCE_ID;
});

await connectDB();

const redis = await createRedisClients();

if (redis) {
  // Without this adapter, socket.to(roomId) only reaches clients attached to
  // THIS process. Two users in the same room on different replicas would never
  // see each other.
  io.adapter(createAdapter(redis.pub, redis.subAdapter));
  console.log("[socket.io] redis adapter attached");
}

await initYjsSync({
  pub: redis?.pub ?? null,
  sub: redis?.subYjs ?? null,
  instanceId: INSTANCE_ID,
});

setupEditorSocket(io, { instanceId: INSTANCE_ID });

server.listen(PORT, HOST, () => {
  console.log(`[server] ${INSTANCE_ID} listening on ${HOST}:${PORT}`);
  console.log(`[server] CORS allowlist: ${allowedOrigins.join(", ") || "(none)"}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown - Docker sends SIGTERM on `stop`, `down` and on scale-down.
// We stop accepting connections, flush pending Yjs writes, then exit.
// ---------------------------------------------------------------------------

let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, draining...`);

  const force = setTimeout(() => {
    console.error("[server] forced exit after 15s");
    process.exit(1);
  }, 15000);
  force.unref();

  try {
    io.close();
    await new Promise((resolve) => server.close(resolve));
    await flushAllDocs();
    if (redis) {
      await Promise.allSettled([
        redis.pub.quit(),
        redis.subAdapter.quit(),
        redis.subYjs.quit(),
      ]);
    }
    await closeDB();
    console.log("[server] clean shutdown");
    process.exit(0);
  } catch (err) {
    console.error("[server] shutdown error:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) =>
  console.error("[server] unhandledRejection:", reason)
);
