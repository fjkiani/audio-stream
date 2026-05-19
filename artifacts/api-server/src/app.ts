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
// API server dist lives at: artifacts/api-server/dist/index.mjs
// Frontend dist lives at:   artifacts/interview-copilot/dist/public/
const frontendDist = path.resolve(
  __dirname,
  "../../../interview-copilot/dist/public",
);
app.use(express.static(frontendDist));

// SPA fallback — any non-API route returns index.html so client-side routing works.
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

export default app;
