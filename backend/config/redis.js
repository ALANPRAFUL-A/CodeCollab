import { createClient } from "redis";

/**
 * Redis is what turns this app from "one process only" into "N processes".
 * We need three logical connections because a node-redis client that is in
 * subscriber mode cannot issue normal commands:
 *
 *   pub        -> shared publisher (Socket.IO adapter + our Yjs channel)
 *   subAdapter -> subscriber owned exclusively by @socket.io/redis-adapter
 *   subYjs     -> subscriber owned exclusively by services/yjsService.js
 *
 * If REDIS_URL is not set we return null and the app runs in single-instance
 * mode (in-memory Socket.IO adapter, no cross-process Yjs sync). That keeps
 * `node server.js` working on a laptop with zero infrastructure.
 */
export const createRedisClients = async () => {
  const url = process.env.REDIS_URL;

  if (!url) {
    console.warn(
      "[redis] REDIS_URL not set - running in SINGLE-INSTANCE mode. " +
        "Do not run more than one replica like this."
    );
    return null;
  }

  const pub = createClient({
    url,
    socket: {
      // Cap the backoff so a restarting Redis doesn't take minutes to recover.
      reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
    },
  });

  const subAdapter = pub.duplicate();
  const subYjs = pub.duplicate();

  for (const [name, client] of [
    ["pub", pub],
    ["sub:adapter", subAdapter],
    ["sub:yjs", subYjs],
  ]) {
    client.on("error", (err) => console.error(`[redis:${name}]`, err.message));
    client.on("reconnecting", () => console.warn(`[redis:${name}] reconnecting`));
  }

  await Promise.all([pub.connect(), subAdapter.connect(), subYjs.connect()]);
  console.log(`[redis] connected -> ${url.replace(/\/\/.*@/, "//***@")}`);

  return { pub, subAdapter, subYjs };
};
