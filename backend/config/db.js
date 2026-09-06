import mongoose from "mongoose";

/**
 * In Docker Compose the backend container almost always wins the startup race
 * against MongoDB. The original implementation called process.exit(1) on the
 * first failure, which turned that race into a crash loop.
 *
 * We retry with a bounded backoff instead, and only give up (exit non-zero, so
 * Docker's restart policy takes over) after MONGO_MAX_RETRIES attempts.
 */
export const connectDB = async () => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error("[mongo] MONGO_URI is not set. Refusing to start.");
    process.exit(1);
  }

  const maxRetries = Number(process.env.MONGO_MAX_RETRIES) || 10;
  const retryDelayMs = Number(process.env.MONGO_RETRY_DELAY_MS) || 3000;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
      });
      console.log(`[mongo] connected (attempt ${attempt})`);

      mongoose.connection.on("disconnected", () =>
        console.warn("[mongo] disconnected")
      );
      mongoose.connection.on("reconnected", () =>
        console.log("[mongo] reconnected")
      );

      return;
    } catch (err) {
      const last = attempt === maxRetries;
      console.error(
        `[mongo] connect failed (attempt ${attempt}/${maxRetries}): ${err.message}`
      );
      if (last) {
        console.error("[mongo] giving up.");
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
};

/** Used by /health so the load balancer stops sending traffic to a broken node. */
export const isDbHealthy = () => mongoose.connection.readyState === 1;

export const closeDB = () => mongoose.connection.close();
