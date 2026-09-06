import * as Y from "yjs";
import Room from "../models/Room.js";

/**
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THE HEART OF THE LOAD-BALANCING STORY
 * ---------------------------------------------------------------------------
 * The original version kept `const docs = {}` per process and, on every single
 * client update, did:
 *
 *     const fullState = Y.encodeStateAsUpdate(ydoc);
 *     await Room.findOneAndUpdate({ roomId }, { content: fullState }, { upsert: true });
 *
 * With one process that is fine. With N processes behind a load balancer it is
 * data loss:
 *
 *   - replica A holds docs["abc"] containing only edits A has seen
 *   - replica B holds docs["abc"] containing only edits B has seen
 *   - both write their FULL state with findOneAndUpdate, which REPLACES the
 *     stored Buffer instead of merging it
 *   => last writer wins, and the other replica's edits vanish from Mongo
 *
 * Three fixes, all in this file:
 *
 *   1. CROSS-INSTANCE SYNC. Every client update is published on a Redis
 *      channel. Peer replicas that hold the same room apply it locally, so all
 *      server-side copies of the doc converge. CRDTs make this order- and
 *      duplicate-independent, so we do not need any locking.
 *
 *   2. PEER STATE HANDSHAKE. When a replica hydrates a room for the first time
 *      it may load a slightly stale Buffer from Mongo (writes are debounced).
 *      So it asks peers for their live state and waits a short, bounded window
 *      before serving the first client.
 *
 *   3. MERGE-ON-SAVE + DEBOUNCE. Persistence reads the stored state and does
 *      Y.mergeUpdates([stored, local]) before writing. The write is therefore
 *      monotonic: it can only ever add information, never remove it. Writes are
 *      also debounced so we do one Mongo write per burst instead of one per
 *      keystroke.
 *
 * Bonus: idle rooms are flushed and evicted, which fixes the unbounded memory
 * growth of the original cache (it never deleted anything).
 * ---------------------------------------------------------------------------
 */

const CHANNEL = "codecollab:yjs";

/** Transaction origin marker so we never re-publish an update we just received. */
const REMOTE_ORIGIN = Symbol("remote");
const LOCAL_ORIGIN = Symbol("local");

const SAVE_DEBOUNCE_MS = Number(process.env.YJS_SAVE_DEBOUNCE_MS) || 2000;
const IDLE_EVICT_MS = Number(process.env.YJS_IDLE_EVICT_MS) || 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.YJS_SWEEP_INTERVAL_MS) || 60 * 1000;
const PEER_SYNC_WAIT_MS = Number(process.env.YJS_PEER_SYNC_WAIT_MS) || 250;

/** roomId -> { ydoc, lastSeen, dirty, saveTimer, saving } */
const docs = new Map();

/** Rooms currently being hydrated, so concurrent joins share one load. */
const hydrating = new Map();

let publisher = null;
let instanceId = "single";
let broadcastLocal = null;
let sweepTimer = null;

const encode = (bytes) => Buffer.from(bytes).toString("base64");
const decode = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

/**
 * Normalise whatever MongoDB hands back for a `Buffer` schema path into a real
 * Uint8Array.
 *
 * THIS IS A GENUINE FOOTGUN, worth spelling out. For `content: Buffer`:
 *
 *   Room.findOne(...)          -> Node Buffer      (Buffer IS a Uint8Array) OK
 *   Room.findOne(...).lean()   -> BSON Binary      (NOT a Uint8Array)       TRAP
 *
 * A BSON Binary has a `.length` METHOD rather than a numeric property, so
 * `new Uint8Array(binary)` does not throw - it silently returns a ZERO-LENGTH
 * array. Yjs then fails with the very unhelpful "Unexpected end of array", and
 * hydration silently loads an EMPTY document, wiping the room.
 *
 * The real bytes live on `.buffer` for a BSON Binary. Handling both shapes keeps
 * this correct whether or not someone later adds or removes `.lean()`.
 */
const toUint8Array = (value) => {
  if (!value) return null;

  // Node Buffer, mongoose Buffer, or a plain Uint8Array.
  if (value instanceof Uint8Array) {
    return value.length ? new Uint8Array(value) : null;
  }

  // BSON Binary: `.buffer` is a Node Buffer holding the payload.
  if (value.buffer instanceof Uint8Array) {
    return value.buffer.length ? new Uint8Array(value.buffer) : null;
  }

  // BSON Binary alternative accessor.
  if (typeof value.value === "function") {
    const inner = value.value(true);
    if (inner instanceof Uint8Array) {
      return inner.length ? new Uint8Array(inner) : null;
    }
  }

  // Raw ArrayBuffer-backed view.
  if (value.buffer instanceof ArrayBuffer) {
    const view = new Uint8Array(value.buffer, value.byteOffset ?? 0, value.byteLength ?? 0);
    return view.length ? new Uint8Array(view) : null;
  }

  // JSON round-tripped array of byte values.
  if (Array.isArray(value)) {
    return value.length ? new Uint8Array(value) : null;
  }

  console.warn(
    `[yjs] unrecognised content type from MongoDB: ${value?.constructor?.name}`
  );
  return null;
};

const publish = (payload) => {
  if (!publisher) return;
  publisher
    .publish(CHANNEL, JSON.stringify({ ...payload, origin: instanceId }))
    .catch((err) => console.error("[yjs] publish failed:", err.message));
};

/**
 * Lets sockets/editorSocket.js hand us a way to push a merged update to the
 * clients connected to THIS process. We deliberately want node-local delivery
 * here (io.local.to) because the Socket.IO Redis adapter already handles the
 * cluster-wide fan-out for normal client traffic.
 */
export const setLocalBroadcaster = (fn) => {
  broadcastLocal = fn;
};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export const initYjsSync = async ({ pub, sub, instanceId: id }) => {
  instanceId = id;

  if (pub && sub) {
    publisher = pub;
    await sub.subscribe(CHANNEL, handlePeerMessage);
    console.log(`[yjs] cross-instance sync active on "${CHANNEL}" as ${id}`);
  } else {
    console.warn("[yjs] no Redis - cross-instance sync DISABLED");
  }

  sweepTimer = setInterval(sweepIdleDocs, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
};

const handlePeerMessage = (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // Ignore our own echo. Redis pub/sub delivers to every subscriber, us included.
  if (!msg || msg.origin === instanceId) return;

  const entry = docs.get(msg.roomId);

  switch (msg.type) {
    case "update": {
      // Only replicas that actually hold this room care. Others will pick the
      // state up from Mongo (plus a peer handshake) when someone joins there.
      if (!entry) return;
      Y.applyUpdate(entry.ydoc, decode(msg.update), REMOTE_ORIGIN);
      entry.lastSeen = Date.now();
      break;
    }

    case "state-request": {
      if (!entry) return;
      publish({
        type: "state-response",
        roomId: msg.roomId,
        update: encode(Y.encodeStateAsUpdate(entry.ydoc)),
      });
      break;
    }

    case "state-response": {
      if (!entry) return;
      const before = Y.encodeStateVector(entry.ydoc);
      Y.applyUpdate(entry.ydoc, decode(msg.update), REMOTE_ORIGIN);
      entry.lastSeen = Date.now();

      // If the peer knew something we did not, push the delta to our own
      // clients - they may have already been served a stale initial state.
      const delta = Y.encodeStateAsUpdate(entry.ydoc, before);
      if (delta.length > 2 && broadcastLocal) {
        broadcastLocal(msg.roomId, delta);
      }
      break;
    }

    default:
      break;
  }
};

// ---------------------------------------------------------------------------
// Document access
// ---------------------------------------------------------------------------

const loadFromMongo = async (roomId) => {
  const ydoc = new Y.Doc();
  const existing = await Room.findOne({ roomId }).select("content").lean();
  const stored = toUint8Array(existing?.content);

  if (stored) {
    try {
      Y.applyUpdate(ydoc, stored, REMOTE_ORIGIN);
    } catch (err) {
      // Corrupt state is recoverable-ish: start empty rather than refusing to
      // open the room, but make the problem loud.
      console.error(`[yjs] stored state for ${roomId} is unreadable:`, err.message);
    }
  }

  return ydoc;
};

const hydrate = async (roomId) => {
  const ydoc = await loadFromMongo(roomId);

  const entry = {
    ydoc,
    lastSeen: Date.now(),
    dirty: false,
    saveTimer: null,
    saving: false,
  };

  // Register before the peer wait so incoming "state-response" messages land.
  docs.set(roomId, entry);

  if (publisher) {
    publish({ type: "state-request", roomId });
    // Bounded wait. Worst case we serve the Mongo state and the delta arrives
    // moments later via broadcastLocal - CRDT merge makes that safe.
    await new Promise((resolve) => setTimeout(resolve, PEER_SYNC_WAIT_MS));
  }

  return entry;
};

const getEntry = async (roomId) => {
  const cached = docs.get(roomId);
  if (cached) {
    cached.lastSeen = Date.now();
    return cached;
  }

  // Collapse concurrent hydrations of the same room into one.
  if (hydrating.has(roomId)) return hydrating.get(roomId);

  const promise = hydrate(roomId).finally(() => hydrating.delete(roomId));
  hydrating.set(roomId, promise);
  return promise;
};

export const getOrCreateDoc = async (roomId) => {
  const entry = await getEntry(roomId);
  return entry.ydoc;
};

/**
 * Called for every `yjs-update` a client sends us.
 * Order matters: apply locally, tell peers, then schedule the debounced write.
 */
export const applyUpdateAndSave = async (roomId, update) => {
  const entry = await getEntry(roomId);
  const bytes = update instanceof Uint8Array ? update : new Uint8Array(update);

  Y.applyUpdate(entry.ydoc, bytes, LOCAL_ORIGIN);
  entry.lastSeen = Date.now();
  entry.dirty = true;

  publish({ type: "update", roomId, update: encode(bytes) });
  scheduleSave(roomId);

  return entry.ydoc;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const scheduleSave = (roomId) => {
  const entry = docs.get(roomId);
  if (!entry || entry.saveTimer) return;

  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null;
    persist(roomId).catch((err) =>
      console.error(`[yjs] save failed for ${roomId}:`, err.message)
    );
  }, SAVE_DEBOUNCE_MS);

  entry.saveTimer.unref?.();
};

const persist = async (roomId) => {
  const entry = docs.get(roomId);
  if (!entry || !entry.dirty || entry.saving) return;

  entry.saving = true;
  entry.dirty = false;

  try {
    const local = Y.encodeStateAsUpdate(entry.ydoc);
    const existing = await Room.findOne({ roomId }).select("content").lean();
    const stored = toUint8Array(existing?.content);

    // The critical difference from the original code: MERGE, never replace.
    // Y.mergeUpdates produces a state containing the union of both inputs, so a
    // concurrent write from another replica can never erase our edits.
    let merged = local;
    if (stored) {
      try {
        merged = Y.mergeUpdates([stored, local]);
      } catch (err) {
        // Never let unreadable stored bytes block a save - our local state is
        // the more complete of the two anyway.
        console.error(`[yjs] merge for ${roomId} failed, writing local state only:`, err.message);
      }
    }

    await Room.findOneAndUpdate(
      { roomId },
      { $set: { content: Buffer.from(merged) } },
      { upsert: true }
    );
  } catch (err) {
    entry.dirty = true; // let the next tick retry
    throw err;
  } finally {
    entry.saving = false;
  }
};

// ---------------------------------------------------------------------------
// Memory management
// ---------------------------------------------------------------------------

const sweepIdleDocs = async () => {
  const cutoff = Date.now() - IDLE_EVICT_MS;

  for (const [roomId, entry] of docs) {
    if (entry.lastSeen > cutoff || entry.saving) continue;

    try {
      if (entry.saveTimer) {
        clearTimeout(entry.saveTimer);
        entry.saveTimer = null;
      }
      await persist(roomId);
      entry.ydoc.destroy();
      docs.delete(roomId);
      console.log(`[yjs] evicted idle room ${roomId}`);
    } catch (err) {
      console.error(`[yjs] eviction of ${roomId} failed:`, err.message);
    }
  }
};

/** Called on SIGTERM so a rolling restart does not drop the last few edits. */
export const flushAllDocs = async () => {
  if (sweepTimer) clearInterval(sweepTimer);

  const pending = [...docs.keys()].map(async (roomId) => {
    const entry = docs.get(roomId);
    if (entry?.saveTimer) {
      clearTimeout(entry.saveTimer);
      entry.saveTimer = null;
    }
    entry.dirty = true;
    try {
      await persist(roomId);
    } catch (err) {
      console.error(`[yjs] flush of ${roomId} failed:`, err.message);
    }
  });

  await Promise.allSettled(pending);
  console.log(`[yjs] flushed ${pending.length} room(s) on shutdown`);
};

/** Exposed on /health for observability. */
export const getYjsStats = () => ({
  cachedRooms: docs.size,
  crossInstanceSync: Boolean(publisher),
});
