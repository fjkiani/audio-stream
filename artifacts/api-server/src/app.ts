import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the Vite-built frontend in production.
// Compiled API server lives at:  /app/artifacts/api-server/dist/index.mjs
// __dirname at runtime:           /app/artifacts/api-server/dist
// Frontend dist lives at:         /app/artifacts/interview-copilot/dist/public
// Relative path (3 levels up → /app, then into artifacts/...):
const frontendDist = path.resolve(
  __dirname,
  "../../../artifacts/interview-copilot/dist/public",
);
app.use(express.static(frontendDist));

// SPA fallback — any non-API route returns index.html so client-side routing works.
// Express 5 requires named wildcards; bare '*' is no longer valid.
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

export default app;
