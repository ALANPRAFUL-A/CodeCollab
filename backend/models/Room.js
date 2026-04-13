import mongoose from "mongoose";

const roomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  content: Buffer,
});

export default mongoose.model("Room", roomSchema);