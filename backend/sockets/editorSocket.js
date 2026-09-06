import * as Y from "yjs";
import {
  getOrCreateDoc,
  applyUpdateAndSave,
  setLocalBroadcaster,
} from "../services/yjsService.js";

const MAX_UPDATE_BYTES = Number(process.env.MAX_UPDATE_BYTES) || 1_000_000;

/** Room ids come from the URL, so validate before using them as a Mongo key. */
const isValidRoomId = (roomId) =>
  typeof roomId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(roomId);

const toBytes = (update) => {
  if (!Array.isArray(update) || update.length === 0) return null;
  if (update.length > MAX_UPDATE_BYTES) return null;
  return new Uint8Array(update);
};

export const setupEditorSocket = (io, { instanceId = "single" } = {}) => {
  /**
   * When yjsService merges state received from a peer replica, it needs to push
   * the delta to the clients attached to THIS process. `io.local` restricts the
   * emit to this node - the Redis adapter would otherwise fan it out to the
   * whole cluster, which is redundant (harmless, but wasteful).
   */
  setLocalBroadcaster((roomId, update) => {
    io.local.to(roomId).emit("yjs-update", { update: Array.from(update) });
  });

  io.on("connection", (socket) => {
    console.log(`[socket] connect ${socket.id} on ${instanceId}`);

    // Handy for debugging which replica a browser tab landed on.
    socket.emit("server-info", { instanceId });

    // ================= JOIN ROOM =================
    socket.on("join_room", async (roomId) => {
      if (!isValidRoomId(roomId)) {
        socket.emit("room-error", { message: "Invalid room id" });
        return;
      }

      try {
        socket.join(roomId);

        // getOrCreateDoc performs the peer-state handshake on a cold room, so
        // the state we send below already includes edits held by other replicas.
        const ydoc = await getOrCreateDoc(roomId);

        socket.emit("yjs-update", {
          update: Array.from(Y.encodeStateAsUpdate(ydoc)),
        });

        // Ask existing users to re-send awareness so the new user sees cursors.
        // With the Redis adapter this now reaches peers on other replicas too.
        socket.to(roomId).emit("awareness-request");
      } catch (err) {
        console.error(`[socket] join_room ${roomId} failed:`, err.message);
        socket.emit("room-error", { message: "Could not open room" });
      }
    });

    // ================= YJS DOC SYNC =================
    socket.on("yjs-update", async ({ roomId, update } = {}) => {
      if (!isValidRoomId(roomId)) return;

      const bytes = toBytes(update);
      if (!bytes) return;

      try {
        await applyUpdateAndSave(roomId, bytes);
        // Cluster-wide thanks to @socket.io/redis-adapter.
        socket.to(roomId).emit("yjs-update", { update });
      } catch (err) {
        console.error(`[socket] yjs-update ${roomId} failed:`, err.message);
      }
    });

    // ================= AWARENESS SYNC (CURSOR) =================
    // Awareness is ephemeral presence data. We never persist it, we only relay.
    socket.on("awareness-update", ({ roomId, update } = {}) => {
      if (!isValidRoomId(roomId)) return;
      if (!toBytes(update)) return;
      socket.to(roomId).emit("awareness-update", { update });
    });

    // ================= DISCONNECT =================
    socket.on("disconnect", (reason) => {
      console.log(`[socket] disconnect ${socket.id} (${reason})`);
    });
  });
};
