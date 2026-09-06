# CodeCollab Infrastructure Guide

Docker + least-connections load balancing + reverse proxy + forward proxy, built from scratch on your existing app.

Everything described here is running and verified. Where a command's output is shown, that output is real.

---

## Part 0 — The one-minute version

```powershell
cd CodeCollab
Copy-Item .env.example .env      # then edit the CHANGE_ME values
docker compose up -d --build
```

Open <http://localhost:8080>.

| What | Where |
|---|---|
| The app | <http://localhost:8080> |
| Load balancer dashboard | <http://localhost:8404> (user/password from `.env`) |
| Backend health | <http://localhost:8080/health> |
| Which replica served me | <http://localhost:8080/api/whoami> |
| Forward proxy check | <http://localhost:8080/api/egress-test> |

---

## Part 1 — What you are building

```
                        ┌───────────┐
                        │  BROWSER  │
                        └─────┬─────┘
                              │  http://localhost:8080
                              ▼
    ╔═════════════════════════════════════════════════╗
    ║  LAYER 2 · REVERSE PROXY   (nginx)              ║
    ║  one public origin · path routing · rate limits  ║
    ║  WebSocket upgrade · gzip · security headers     ║
    ╚══════════┬══════════════════════════┬═══════════╝
               │ / (everything else)      │ /api/*  /socket.io/*
               ▼                          ▼
    ┌────────────────────┐   ╔═════════════════════════════════════╗
    │ LAYER 1 · FRONTEND │   ║  LAYER 3 · LOAD BALANCER (HAProxy)  ║
    │ nginx + built SPA  │   ║  balance leastconn                  ║
    │ SPA fallback       │   ║  + sticky SRVID cookie for /socket.io║
    └────────────────────┘   ╚══════┬═══════════┬═══════════┬══════╝
                                    ▼           ▼           ▼
                            ┌───────────┐ ┌───────────┐ ┌───────────┐
                            │ backend-1 │ │ backend-2 │ │ backend-3 │  LAYER 4
                            │   :5000   │ │   :5000   │ │   :5000   │
                            └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
                                  └─────────────┼─────────────┘
                                    ┌───────────┴────────────┐
                                    ▼                        ▼
                             ┌────────────┐          ┌──────────────┐
                             │  MongoDB   │          │    Redis     │
                             │ users +    │          │ Socket.IO    │
                             │ documents  │          │ adapter +    │
                             └────────────┘          │ Yjs sync     │
                                                     └──────────────┘
                                  │
                                  ▼  the ONLY way out
                     ╔════════════════════════════╗
                     ║ LAYER 5 · FORWARD PROXY    ║ ──► internet
                     ║ (Squid) allowlist + audit  ║
                     ╚════════════════════════════╝
```

### Reverse proxy vs forward proxy — the distinction that trips everyone up

Same word, opposite direction of travel.

|  | Reverse proxy | Forward proxy |
|---|---|---|
| Sits in front of | **your servers** | **your clients** |
| Traffic direction | inbound (internet → you) | outbound (you → internet) |
| Client knows it exists? | No, it thinks it *is* the server | Yes, it is configured to use it |
| Here | nginx on `:8080` | Squid on `:3128` |
| Answers | "who is allowed to reach my app, and which backend handles it" | "what is my app allowed to reach on the internet" |

A useful mnemonic: the reverse proxy protects the **server** from the internet. The forward proxy protects the **internet** from your server (and your server from a malicious dependency).

### The five layers and why each exists

**Layer 1 — Frontend container.** `vite build` produces static files. There is no Node runtime in the final image, just nginx and ~3 MB of assets. Also holds the SPA fallback so `/room/abc123` survives a hard refresh.

**Layer 2 — Reverse proxy.** One origin for everything. This is what removes CORS entirely, makes the sticky cookie a plain same-origin cookie, terminates the WebSocket upgrade, and applies rate limiting once at the edge instead of in all three replicas.

**Layer 3 — Load balancer.** Spreads new sessions across replicas by **least connections**, and pins existing Socket.IO sessions with a cookie. Also health-checks the replicas and removes broken ones.

**Layer 4 — Application replicas.** Three identical Node containers. Identical is the point: any one can die and be replaced.

**Layer 5 — Forward proxy.** The single, auditable egress point.

---

## Part 2 — Why your app needed code changes first

This is the important part. You cannot put the original CodeCollab behind a load balancer and have it work. Three separate things break, and none of them fail loudly — they cause **silent data loss**.

### Blocker 1: the per-process Yjs cache clobbered documents

`backend/services/yjsService.js` had:

```js
const docs = {};                                   // per-process, never evicted

// ...on every client update:
const fullState = Y.encodeStateAsUpdate(ydoc);
await Room.findOneAndUpdate(
  { roomId },
  { content: Buffer.from(fullState) },             // REPLACES the stored bytes
  { upsert: true }
);
```

With one process that is fine. With three:

- replica A's `docs["abc"]` holds only the edits A saw
- replica B's `docs["abc"]` holds only the edits B saw
- both write their **full** state, and `findOneAndUpdate` **replaces** rather than merges
- last writer wins, and the other replica's edits are gone from MongoDB

I proved this before changing anything. Two replicas diverge to `AAACCC` and `AAABBB`:

```
OLD (replace)   : AAABBB          <- "CCC" is gone forever
NEW (merge)     : AAACCCBBB       <- both survive
```

The fix is `Y.mergeUpdates([stored, local])` before writing. Merge is *monotonic*: the result always contains the union of both inputs, so a concurrent write from another replica can never erase yours.

### Blocker 2: `socket.to(roomId)` did not cross process boundaries

`socket.to(roomId).emit(...)` uses Socket.IO's default **in-memory** adapter. A broadcast from replica A is invisible to clients on replica B. Two people in the same room, balanced onto different replicas, would never see each other type — not late, *never*.

Fixed with `@socket.io/redis-adapter`, plus a second Redis channel (`codecollab:yjs`) so the *server-side* Yjs documents converge too. There is also a peer state handshake: a replica opening a room cold asks its peers for their live state before serving the first client, because the MongoDB write is debounced and could be up to 2 s stale.

### Blocker 3: the Socket.IO handshake needs session affinity

Socket.IO's default transport starts as HTTP long-polling and *then* upgrades to WebSocket. That handshake spans several separate HTTP requests sharing one session id. If they land on different replicas you get an endless `Session ID unknown` loop.

So we need least-connections **and** stickiness together. In open-source nginx you cannot have both — `least_conn` and `ip_hash`/`hash` are mutually exclusive in one upstream block, and cookie-based `sticky` is NGINX Plus only. **That is the reason this stack uses HAProxy for balancing and nginx for reverse proxying.** HAProxy does both in three lines.

### Also changed

| Problem | Fix |
|---|---|
| `server.listen(5000)` hardcoded | `PORT` / `HOST` env vars |
| CORS allowlist hardcoded in two places | single `CORS_ORIGINS` env var |
| No health endpoint (LB checks got 404) | `GET /health`, returns **503** when MongoDB is down so the LB pulls the node out |
| `process.exit(1)` on first Mongo failure | bounded retry loop, so the container does not crash-loop losing the startup race |
| No `start` script, `main` pointed at a nonexistent `index.js` | fixed; container runs `node server.js` directly |
| Frontend used **absolute** backend URLs, bypassing the proxy entirely | `src/config.js`, defaults to same-origin relative URLs |
| `docs = {}` never evicted (memory leak) | idle rooms flushed and evicted after 5 min |
| One Mongo write per keystroke | debounced to one write per 2 s burst |
| No graceful shutdown | `SIGTERM` flushes pending Yjs writes before exit |

---

## Part 3 — File map

```
CodeCollab/
├── docker-compose.yml              orchestrates all 9 containers + 3 networks
├── .env.example                    template — copy to .env
├── .env                            your real secrets (gitignored)
│
├── backend/
│   ├── Dockerfile                  2-stage, node:24-alpine, non-root
│   ├── .dockerignore
│   ├── server.js                   env config, /health, /api/whoami, Redis adapter
│   ├── config/db.js                Mongo with retry + isDbHealthy()
│   ├── config/redis.js             NEW — 3 Redis clients
│   ├── services/yjsService.js      cross-instance sync + merge-on-save
│   └── sockets/editorSocket.js     room validation + local broadcaster
│
├── frontend/
│   ├── Dockerfile                  build stage → nginx static stage
│   ├── nginx.conf                  static origin: SPA fallback + cache policy
│   ├── .dockerignore
│   ├── vite.config.js              dev proxy mirrors production routing
│   └── src/config.js               NEW — same-origin URL policy
│
└── infra/
    ├── reverse-proxy/
    │   ├── nginx.conf              LAYER 2
    │   └── snippets/proxy-common.conf
    ├── load-balancer/
    │   └── haproxy.cfg             LAYER 3 — least connections
    └── forward-proxy/
        ├── squid.conf              LAYER 5
        └── allowed-domains.txt     egress allowlist
```

---

## Part 4 — Step by step

### Step 1 · Prerequisites

Docker Desktop must be **running**, not just installed.

```powershell
docker version
docker compose version
```

If you get `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`, the engine is not started. Launch Docker Desktop and wait for the whale icon to settle.

### Step 2 · Create your `.env`

```powershell
cd CodeCollab
Copy-Item .env.example .env
```

Generate real secrets:

```powershell
# PowerShell — a 48-byte random secret
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

Fill in `JWT_SECRET`, `MONGO_PASSWORD`, `REDIS_PASSWORD`, `HAPROXY_STATS_PASSWORD`.

Two things worth understanding:

- **All three replicas must share `JWT_SECRET`.** A token minted by backend-1 gets verified by whichever replica the balancer picks next. A mismatch logs users out at random. (The app silently falls back to the literal string `fallback_secret` if unset, which "works" while being trivially forgeable — so set it.)
- **`MONGO_PASSWORD` is only applied when the volume is first created.** Changing it later requires `docker compose down -v`, which deletes your data.

Compose validates this for you. Omit a required value and it refuses to start rather than booting something broken:

```
error: set MONGO_PASSWORD in .env
```

Sanity check before building:

```powershell
docker compose config --quiet    # exit 0 = valid
git check-ignore -v .env         # confirm your secrets are not tracked
```

### Step 3 · Build

```powershell
docker compose build
```

Both Dockerfiles are **multi-stage**, which is worth understanding because it is where build speed and image size come from.

Backend:

```dockerfile
FROM node:24-alpine AS deps
COPY package.json package-lock.json ./    # manifests ONLY
RUN npm ci --omit=dev                     # cached until deps change

FROM node:24-alpine AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node                                 # never run as root
```

Copying the manifests before the source is the whole trick: editing `server.js` reuses the cached `npm ci` layer, so rebuilds take about a second instead of re-resolving the dependency tree.

Why `node:24-alpine` specifically: `NODE_USE_ENV_PROXY` — the flag that makes Node's built-in `fetch` honour `HTTP_PROXY` — requires Node ≥ 22.21 or ≥ 24.5. That is how the app reaches the forward proxy. ([Node.js enterprise network configuration](https://nodejs.org/en/learn/http/enterprise-network-configuration))

Frontend, the important subtlety:

```dockerfile
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build
```

**Vite inlines `import.meta.env.*` at build time.** It is a build ARG, not a runtime env var. You cannot change the backend URL of an already-built image — you must rebuild. The default is empty, meaning "same origin", which is what routes everything through the reverse proxy.

### Step 4 · Start

```powershell
docker compose up -d
docker compose ps
```

All nine services should reach `healthy`:

```
SERVICE         STATUS                    PORTS
backend-1       Up 26 seconds (healthy)
backend-2       Up 26 seconds (healthy)
backend-3       Up 26 seconds (healthy)
forward-proxy   Up 27 seconds (healthy)   127.0.0.1:3128->3128/tcp
frontend        Up 4 minutes (healthy)    80/tcp
load-balancer   Up 4 minutes (healthy)    0.0.0.0:8404->8404/tcp
mongo           Up 4 minutes (healthy)
redis           Up 4 minutes (healthy)
reverse-proxy   Up 4 minutes (healthy)    0.0.0.0:8080->80/tcp
```

Note what is **not** published: the backends, MongoDB and Redis have no host ports at all. The only ways in are `:8080` (the app) and `:8404` (the dashboard). That is the reverse proxy doing its job.

Startup order is enforced by `depends_on` conditions, and the choices are deliberate:

- backends wait for `mongo` and `redis` to be **healthy** — they need a working database
- the load balancer only waits for backends to have **started**, because HAProxy is designed to boot with dead servers and add them as its own health checks pass
- the reverse proxy waits for `frontend` and `load-balancer` to be **healthy**, because nginx resolves `upstream` hostnames once at startup and refuses to boot if they do not resolve

---

## Part 5 — Layer deep dives

### Layer 2 · Reverse proxy (nginx)

Three routes, three different behaviours.

**The WebSocket upgrade.** `Upgrade` and `Connection` are hop-by-hop headers, so nginx drops them unless you forward them explicitly:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

location /socket.io/ {
    proxy_pass http://app_lb_realtime;
    proxy_http_version 1.1;                          # Upgrade needs HTTP/1.1
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;                        # Socket.IO pings every 25s
    proxy_buffering off;                             # realtime: never buffer
    proxy_next_upstream off;                         # never replay a handshake
}
```

The `map` is needed rather than a hardcoded `Connection: upgrade` because this same location also serves the *long-polling* requests, which have no `Upgrade` header.

`proxy_next_upstream off` is a correctness requirement, not a tuning knob: retrying a handshake against a different replica is precisely the bug that stickiness exists to prevent.

**Two upstreams to the same place.** This looks redundant and is not:

```nginx
upstream app_lb          { server load-balancer:80; keepalive 32; }
upstream app_lb_realtime { server load-balancer:80; }   # NO keepalive
```

An upgraded WebSocket connection is not reusable, so it must never enter a keepalive pool. Separate blocks keep the two behaviours from interfering.

**Rate limiting at the edge**, applied once instead of in every replica:

```nginx
limit_req_zone $binary_remote_addr zone=auth_zone:10m rate=60r/m;

location /api/auth/ {
    limit_req zone=auth_zone burst=30 nodelay;
}
```

Login/register are the brute-force target so they get the tight bucket. Caveat: on Docker Desktop, traffic through a published port often appears to come from the Docker gateway, so local clients can share one bucket. Limits are set generously for that reason.

### Layer 3 · Load balancer (HAProxy) — least connections

This is the centrepiece. The whole algorithm is:

```
request arrives
  ├─ has a valid SRVID cookie? ──► go straight to that replica   (affinity wins)
  └─ no cookie (new session)?  ──► pick the replica with the FEWEST
                                   active connections, then pin it
```

That ordering is what makes it correct. Affinity never breaks an existing session, and least-connections still decides where every *new* session lands.

**Why least connections and not round-robin.** Round-robin counts requests. This app's connections are long-lived WebSockets that last a whole editing session, and rooms have wildly different traffic. Round-robin would happily hand a 4th user to a replica already holding 300 sockets. `leastconn` looks at how many connections each replica is *currently* holding — the metric that actually reflects load for persistent connections.

**Two backends over the same three servers.** The two kinds of traffic have different affinity needs:

```haproxy
frontend fe_codecollab
    bind *:80
    acl is_realtime path_beg /socket.io/
    use_backend be_realtime if is_realtime
    default_backend be_stateless

backend be_realtime                                   # stateful
    balance leastconn
    cookie SRVID insert indirect nocache httponly
    server backend-1 backend-1:5000 check cookie n1 ...

backend be_stateless                                  # stateless — NO cookie
    balance leastconn
    server backend-1 backend-1:5000 check ...
```

Auth is a JWT in `localStorage` with no server-side session, so pinning those requests would only make them spread *less* evenly. Splitting means REST traffic balances perfectly while realtime traffic stays pinned.

The cookie flags each do a job: `insert` adds the `Set-Cookie`; `indirect` strips it from the request so your app never has to know this mechanism exists; `nocache` stops a shared cache storing a response carrying someone else's affinity; `httponly` keeps JavaScript out of it.

**The timeout that catches everyone:**

```haproxy
timeout tunnel 1h
```

Once a connection upgrades to WebSocket, HAProxy stops applying client/server timeouts and uses `tunnel` instead. Leave it at the default and idle editor tabs get silently killed.

**Health checks decide rotation:**

```haproxy
option httpchk
http-check send meth GET uri /health ver HTTP/1.1 hdr Host localhost
http-check expect status 200
server backend-1 backend-1:5000 check inter 3s fall 3 rise 2 ...
```

Check every 3 s; mark down after 3 consecutive failures; only return after 2 consecutive successes. Since `/health` returns 503 when MongoDB is unreachable, a replica that cannot save work is removed rather than being handed users.

**Docker DNS.** Container IPs change on every recreate, so HAProxy must re-resolve at runtime rather than caching the startup IP:

```haproxy
resolvers docker
    nameserver dns1 127.0.0.11:53
...
server backend-1 backend-1:5000 ... resolvers docker init-addr last,libc,none
```

`init-addr last,libc,none` lets HAProxy start even when a name does not resolve yet, which is what makes it tolerant of the compose startup race.

### Layer 5 · Forward proxy (Squid) — and why it cannot be bypassed

Most tutorials set `HTTP_PROXY` and call it done. That is a *suggestion*: any code that ignores the variable goes straight out. Here it is enforced at the **network** level:

```yaml
networks:
  edge:                    # normal bridge, has internet
    driver: bridge
  app-internal:            # NO default gateway — no route off the host
    driver: bridge
    internal: true
  egress:                  # normal bridge, has internet
    driver: bridge
```

The backends are on `app-internal` only. `forward-proxy` straddles `app-internal` and `egress`, making it the sole bridge to the outside world. Verified:

```powershell
# direct, Squid bypassed
docker exec codecollab-backend-1 sh -c 'unset HTTP_PROXY HTTPS_PROXY; wget -qO/dev/null https://api.github.com/zen; echo exit=$?'
#   wget: bad address 'api.github.com'
#   exit=1
```

It fails at DNS. There is no route out, full stop.

The allowlist is the security control:

```squid
acl allowed_domains dstdomain "/etc/squid/allowed-domains.txt"
http_access allow localnet allowed_domains
http_access deny all                       # default deny
```

Both paths verified:

```
172.20.0.6  TCP_TUNNEL/200  CONNECT api.github.com:443   <- allowlisted
172.22.0.1  TCP_DENIED/403  GET http://example.com/      <- not allowlisted
```

To allow a new destination, edit `infra/forward-proxy/allowed-domains.txt` (a leading dot matches subdomains) then `docker compose restart forward-proxy`.

**Two honest limitations.**

1. **This is an HTTP/HTTPS proxy only.** MongoDB and Redis speak their own binary wire protocols and do not traverse it. That is fine here because both run inside `app-internal`. If you moved to MongoDB Atlas you would need a SOCKS proxy or a firewall rule, not Squid.
2. **HTTPS cannot be cached.** It arrives as an opaque `CONNECT` tunnel. Caching only benefits plain HTTP unless you terminate TLS (SSL bumping), which this config deliberately does not do.

---

## Part 6 — Verification playbook

Run these to confirm each layer yourself. All outputs below are real.

### The chain is connected

```powershell
Invoke-WebRequest http://localhost:8080/health -UseBasicParsing | Select-Object -Expand Content
```

```json
{"status":"ok","instance":"backend-1","db":"up","uptimeSeconds":165,"cachedRooms":0,"crossInstanceSync":true}
```

`crossInstanceSync: true` is the one to look for — it means the Redis Yjs channel is live.

### Least connections is balancing

```powershell
$hits = @{}
1..30 | ForEach-Object {
  $j = (Invoke-WebRequest http://localhost:8080/api/whoami -UseBasicParsing).Content | ConvertFrom-Json
  if ($hits.ContainsKey($j.instance)) { $hits[$j.instance]++ } else { $hits[$j.instance] = 1 }
}
$hits
```

```
backend-1 -> 10
backend-2 -> 10
backend-3 -> 10
```

### Sticky sessions are pinning

```powershell
$hs = "http://localhost:8080/socket.io/?EIO=4&transport=polling"
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$r = Invoke-WebRequest $hs -UseBasicParsing -WebSession $s
$r.Headers['Set-Cookie']       # SRVID=n3; path=/; HttpOnly
$r.Headers['X-Served-By']      # backend-3

# reuse that cookie 15 times — every one must stay on the same replica
1..15 | ForEach-Object { (Invoke-WebRequest $hs -UseBasicParsing -WebSession $s).Headers['X-Served-By'] } | Sort-Object -Unique
```

```
backend-3        <- exactly one value = sticky
```

Meanwhile `/api/whoami` returns **no** `Set-Cookie` at all, because `be_stateless` deliberately has no cookie directive.

Fresh handshakes without a cookie spread across all three: `2/2/2` out of 6.

### The forward proxy is the only way out

```powershell
Invoke-WebRequest http://localhost:8080/api/egress-test -UseBasicParsing | Select-Object -Expand Content
```

```json
{"ok":true,"status":200,"body":"Speak like a human.","viaProxy":"http://forward-proxy:3128","elapsedMs":504,"instance":"backend-1"}
```

Watch the audit trail live:

```powershell
docker compose logs -f forward-proxy
```

### Cross-replica collaboration actually works

The real test. Two clients pinned to *different* replicas by sending the sticky cookie by hand, then a *third* replica loading the room cold from MongoDB:

```
client A -> backend-1 (SRVID=n1)
client B -> backend-3 (SRVID=n3)
  [PASS] clients landed on DIFFERENT replicas
  [PASS] B received A's edit
  [PASS] A received B's edit
  [PASS] A and B converged to identical text
client C -> backend-2 (SRVID=n2)
  [PASS] C is a replica that never held this room
  [PASS] C loaded the FULL merged document from MongoDB
  [PASS] both users' edits survived (no last-write-wins clobbering)
```

Or just do it by hand: open <http://localhost:8080/room/demo> in two different browsers (or one normal + one private window), log in as two users, and type in both.

### Failover

```powershell
docker compose stop backend-2
# 24 requests to /api/whoami:
#   backend-1 -> 12
#   backend-3 -> 12
#   failed requests: 0
docker compose start backend-2
# back to 6/6/6 within ~15s, automatically
```

The dashboard at <http://localhost:8404> shows the stopped server as `MAINT (resolution)` and returns it to `UP` on its own once health checks pass.

---

## Part 7 — Day-to-day operations

```powershell
# logs
docker compose logs -f                          # everything
docker compose logs -f backend-1                # one replica
docker compose logs -f forward-proxy            # egress audit trail

# after changing application code
docker compose up -d --build backend-1 backend-2 backend-3

# after changing a proxy/LB config (mounted, so no rebuild)
docker compose restart reverse-proxy
docker compose restart load-balancer
docker compose restart forward-proxy

# after changing VITE_API_URL (build-time!)
docker compose build frontend && docker compose up -d frontend

# scale up — add backend-4 to docker-compose.yml AND to both
# backends in haproxy.cfg (with a unique `cookie n4`), then restart the LB

# inspect the database
docker compose exec mongo mongosh -u codecollab -p --authenticationDatabase admin codecollab

# stop
docker compose down                             # keeps data
docker compose down -v                          # DELETES mongo + redis volumes
```

### Local development without Docker

Still works, and now behaves the same way, because `vite.config.js` proxies `/api` and `/socket.io` exactly like the reverse proxy does:

```powershell
cd backend  ; npm start      # needs MONGO_URI + JWT_SECRET; REDIS_URL optional
cd frontend ; npm run dev    # http://localhost:5173
```

Without `REDIS_URL` the backend logs a single-instance warning and uses the in-memory adapter. Fine for one process; never do it with replicas.

You can also point the dev server at the Dockerised cluster:

```powershell
$env:BACKEND_TARGET = "http://localhost:8080"; npm run dev
```

---

## Part 8 — Troubleshooting

These are the failures actually hit while building this, with the real fixes.

**Squid restart-loops with `FATAL: Cannot open '/dev/stdout' for writing`.**
Squid drops privileges from root to the `proxy` user, and `/dev/stdout` is `/proc/self/fd/1` → a pipe owned by root, so the reopen gets `EACCES`. Do not log to `/dev/stdout`. The `ubuntu/squid` image already runs `tail -F /var/log/squid/{access,cache}.log`, so write to those files and they still show up in `docker compose logs`.

**Squid exits with `ERROR: Directive 'dns_v4_first' is obsolete`.**
Removed in Squid 6, and it is a hard config error, not a warning. Delete the line.

**`manualChunks is not a function` during the frontend build.**
Vite 8 ships Rolldown, which requires the *function* form of `manualChunks`. The object form used by older Vite throws.

**Yjs `Unexpected end of array`, and documents load empty.**
This one is nasty and worth remembering. In mongoose 9, a `Buffer` schema path returns different types depending on `.lean()`:

```
Room.findOne(...)         -> Node Buffer   (is a Uint8Array)  OK
Room.findOne(...).lean()  -> BSON Binary   (NOT a Uint8Array) TRAP
```

A BSON `Binary` has a `.length` **method**, not a numeric property, so `new Uint8Array(binary)` does not throw — it silently returns a **zero-length** array. Yjs then reports `Unexpected end of array`, and hydration silently loads an empty document. The real bytes live on `.buffer`. `yjsService.js` has a `toUint8Array()` helper that handles both shapes.

**`X-Served-By` is empty on `/socket.io/` responses.**
Socket.IO attaches its own listener to the HTTP server and handles those requests *before* Express middleware runs, so app-level headers never apply. Use the engine hooks instead:

```js
io.engine.on("initial_headers", (h) => { h["X-Served-By"] = INSTANCE_ID; });
io.engine.on("headers",         (h) => { h["X-Served-By"] = INSTANCE_ID; });
```

**nginx exits with `host not found in upstream`.**
nginx resolves `upstream` names once at startup. Ensure `depends_on` uses `condition: service_healthy` for `frontend` and `load-balancer`.

**Everything is up but the browser shows CORS errors.**
`VITE_API_URL` is probably set to an absolute URL, so the browser is talking to the backend directly and skipping the proxy. Leave it empty, then `docker compose build frontend`.

**Editor connects then disconnects every ~30 s.**
A proxy timeout below Socket.IO's 25 s ping interval. Check `proxy_read_timeout` in the reverse proxy and `timeout tunnel` in HAProxy.

**Backend crash-loops with a Mongo auth failure.**
You changed `MONGO_PASSWORD` after the volume was created. Those credentials are only applied on first initialisation: `docker compose down -v` (destroys data) or reset the user inside mongosh.

---

## Part 9 — What this is not yet

Honest gaps, so you know where the edges are.

- **No TLS.** Everything is plain HTTP on localhost. For a real deployment, terminate HTTPS at the reverse proxy (Let's Encrypt via certbot, or Caddy which does it automatically), then add `secure` to the sticky cookie and set `Strict-Transport-Security`.
- **Single points of failure.** One reverse proxy, one load balancer, one Mongo, one Redis. The *application* tier is redundant; nothing else is. Real HA needs a Mongo replica set, Redis Sentinel or Cluster, and two balancers behind a virtual IP.
- **Affinity is per-client, not per-room.** The sticky cookie co-locates a *client*, not a *room*. Correctness no longer depends on room affinity — that is what the Redis sync and merge-on-save are for — but two users in one room may sit on different replicas and take one extra Redis hop. Routing by room would need `roomId` in the connection URL (`io(url, { query: { roomId } })`) plus `hash $arg_roomId consistent`.
- **Yjs updates travel as JSON byte arrays.** `Array.from(update)` is roughly 4–8× larger than the raw binary. Switching to binary frames would cut realtime bandwidth substantially.
- **`runCode` executes user JavaScript in the browser** via `new Function(code)()`. It never touches the server, so there is no server-side sandbox to worry about — but it is arbitrary code in the user's own tab.
- **No CI, no image scanning, no log aggregation, no metrics.** Natural next steps: `docker scout cve`, Prometheus (HAProxy can export metrics directly), and shipping logs somewhere durable.
- **Pre-existing app bug, unrelated to infrastructure.** `backend/models/User.js` has a `pre('save')` hook that calls `next()` without `return`ing when the password is unmodified, so it falls through and re-hashes an already-hashed password. It does not bite on register or login today, but it will corrupt a password the first time you save a user document for any other reason.

---

## Appendix — Command reference

| Goal | Command |
|---|---|
| Validate compose file | `docker compose config --quiet` |
| Build everything | `docker compose build` |
| Start | `docker compose up -d` |
| Status of all services | `docker compose ps` |
| Follow all logs | `docker compose logs -f` |
| Egress audit trail | `docker compose logs -f forward-proxy` |
| Which replica served me | `curl http://localhost:8080/api/whoami` |
| Full-chain health | `curl http://localhost:8080/health` |
| Prove the forward proxy | `curl http://localhost:8080/api/egress-test` |
| LB dashboard | <http://localhost:8404> |
| LB states as CSV | `curl -u admin:PASS "http://localhost:8404/;csv"` |
| Test the allowlist | `curl -x http://localhost:3128 http://example.com` → 403 |
| Shell into a replica | `docker compose exec backend-1 sh` |
| Simulate a replica dying | `docker compose stop backend-2` |
| Stop, keep data | `docker compose down` |
| Stop, delete data | `docker compose down -v` |
