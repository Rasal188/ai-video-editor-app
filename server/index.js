import { createApp } from "./app.js";
import { config } from "./config.js";
import { checkHealth, closePool } from "./db/index.js";

const app = createApp();

const server = app.listen(config.server.port, config.server.host, async () => {
  console.log(`[Backend Server] Running on http://${config.server.host}:${config.server.port} (${config.env})`);

  // Log initial database connection status
  const dbHealth = await checkHealth();
  if (dbHealth.ok) {
    console.log(`[PostgreSQL] Connected (${dbHealth.latencyMs}ms) - ${dbHealth.version}`);
  } else {
    console.warn(`[PostgreSQL Warning]: ${dbHealth.error} (Ensure PostgreSQL is running and DATABASE_URL is configured)`);
  }
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[Backend Server] Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    try {
      await closePool();
      console.log("[Backend Server] Connections closed. Exiting process.");
      process.exit(0);
    } catch (err) {
      console.error("[Backend Server] Error during shutdown:", err);
      process.exit(1);
    }
  });

  // Force close if graceful shutdown hangs
  setTimeout(() => {
    console.error("[Backend Server] Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
