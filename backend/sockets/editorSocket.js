import * as Y from "yjs";
import { getOrCreateDoc, applyUpdateAndSave } from "../services/yjsService.js";

export const setupEditorSocket = (io) => {
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // ================= JOIN ROOM =================
    socket.on("join_room", async (roomId) => {
      socket.join(roomId);

      const ydoc = await getOrCreateDoc(roomId);

      // Send full document state to the new user
      const state = Y.encodeStateAsUpdate(ydoc);
      socket.emit("yjs-update", {
        update: Array.from(state),
      });

      // Ask existing users to re-send their awareness
      // so the new user sees their cursors immediately
      socket.to(roomId).emit("awareness-request");
    });

    // ================= YJS DOC SYNC =================
    socket.on("yjs-update", async ({ roomId, update }) => {
      await applyUpdateAndSave(roomId, update);
      // Broadcast to everyone else in the room
      socket.to(roomId).emit("yjs-update", { update });
    });

    // ================= AWARENESS SYNC (CURSOR) =================
    socket.on("awareness-update", ({ roomId, update }) => {
      // Broadcast cursor position to everyone else in the room
      socket.to(roomId).emit("awareness-update", { update });
    });

    // ================= DISCONNECT =================
    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });
};