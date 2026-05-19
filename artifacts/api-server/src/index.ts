import http from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachLiveTranscribe } from "./lib/assemblyLive";
import { runMigrations } from "./lib/migrate";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);

// WebSocket route at /api/live for live transcription.
attachLiveTranscribe(server);

// Attempt DB migrations at startup; non-fatal so the server still starts
// even if the DB is temporarily unreachable.
runMigrations().catch((err) => {
  logger.warn({ err }, "Startup migration failed — server will start anyway");
});

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening (HTTP + WS)");
});
