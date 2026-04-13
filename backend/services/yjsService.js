import * as Y from "yjs";
import Room from "../models/Room.js";

const docs = {};

export const getOrCreateDoc = async (roomId) => {
  if (!docs[roomId]) {
    const ydoc = new Y.Doc();

    const existing = await Room.findOne({ roomId });

    if (existing && existing.content) {
      // ✅ Buffer works directly with Yjs
      Y.applyUpdate(ydoc, existing.content);
    }

    docs[roomId] = ydoc;
  }

  return docs[roomId];
};

export const applyUpdateAndSave = async (roomId, update) => {
  const ydoc = await getOrCreateDoc(roomId);

  // ✅ Apply incoming update
  Y.applyUpdate(ydoc, new Uint8Array(update));

  // ✅ Encode full state
  const fullState = Y.encodeStateAsUpdate(ydoc);

  // 🔥 FIX: Convert to Buffer before saving
  await Room.findOneAndUpdate(
    { roomId },
    { content: Buffer.from(fullState) }, // ✅ FIX HERE
    { upsert: true }
  );

  return ydoc;
};