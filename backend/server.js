import express from "express";
import dotenv from "dotenv";

dotenv.config();
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

import { connectDB } from "./config/db.js";
import { setupEditorSocket } from "./sockets/editorSocket.js";

import authRoutes from "./routes/authRoutes.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// 🔥 Connect DB
await connectDB();

// 🔥 Setup sockets
setupEditorSocket(io);

server.listen(5000, () => {
  console.log("Server running on port 5000");
});