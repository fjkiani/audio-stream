import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { db, transcriptsTable } from "@workspace/db";
import { logger } from "./logger";

const ASSEMBLY_WS =
  "wss://streaming.assemblyai.com/v3/ws" +
  "?sample_rate=16000" +
  "&encoding=pcm_s16le" +
  "&format_turns=true";

interface AssemblyTurn {
  type: "Turn";
  turn_order: number;
  transcript: string;
  end_of_turn: boolean;
  turn_is_formatted: boolean;
}
interface AssemblyBegin {
  type: "Begin";
  id: string;
  expires_at: number;
}
interface AssemblyTermination {
  type: "Termination";
  audio_duration_seconds?: number;
  session_duration_seconds?: number;
}
type AssemblyMessage =
  | AssemblyTurn
  | AssemblyBegin
  | AssemblyTermination
  | { type: string; [k: string]: unknown };

interface ClientControl {
  type: "save" | "stop";
  title?: string;
}

/**
 * One bridge per client connection. Owns:
 *  - the upstream AssemblyAI WS
 *  - the assembled, finalised transcript (concatenated end_of_turn segments)
 *  - the lifecycle (close one side → close the other)
 */
class LiveBridge {
  private upstream: WebSocket | null = null;
  private finalParts: string[] = [];
  private currentPartial = "";
  private terminated = false;
  private apiKey: string;

  constructor(
    private readonly client: WebSocket,
    apiKey: string,
  ) {
    this.apiKey = apiKey;
  }

  start(): void {
    this.upstream = new WebSocket(ASSEMBLY_WS, {
      headers: { Authorization: this.apiKey },
    });

    this.upstream.on("open", () => {
      this.sendToClient({ type: "ready" });
    });

    this.upstream.on("message", (data: RawData) => {
      // AssemblyAI sends JSON text frames.
      let parsed: AssemblyMessage;
      try {
        parsed = JSON.parse(data.toString()) as AssemblyMessage;
      } catch {
        return;
      }

      if (parsed.type === "Turn") {
        const t = parsed as AssemblyTurn;
        if (t.end_of_turn) {
          if (t.transcript.trim()) {
            this.finalParts.push(t.transcript.trim());
          }
          this.currentPartial = "";
          this.sendToClient({
            type: "final",
            text: t.transcript,
            turn_order: t.turn_order,
          });
        } else {
          this.currentPartial = t.transcript;
          this.sendToClient({
            type: "partial",
            text: t.transcript,
            turn_order: t.turn_order,
          });
        }
      } else if (parsed.type === "Begin") {
        this.sendToClient({
          type: "begin",
          session_id: (parsed as AssemblyBegin).id,
        });
      } else if (parsed.type === "Termination") {
        const term = parsed as AssemblyTermination;
        this.sendToClient({
          type: "terminated",
          audio_duration_seconds: term.audio_duration_seconds ?? null,
        });
      }
    });

    this.upstream.on("error", (err) => {
      logger.error({ err: err.message }, "AssemblyAI WS error");
      this.sendToClient({
        type: "error",
        message: `Upstream error: ${err.message}`,
      });
      this.shutdown(1011, "upstream-error");
    });

    this.upstream.on("close", (code, reason) => {
      logger.info(
        { code, reason: reason.toString() },
        "AssemblyAI WS closed",
      );
      if (!this.terminated) {
        this.sendToClient({
          type: "upstream_closed",
          code,
          reason: reason.toString(),
        });
      }
      this.closeClient(1000);
    });

    // ─── Client → server ────────────────────────────────────────────
    let bytesSent = 0;
    let chunkCount = 0;
    this.client.on("message", (data, isBinary) => {
      if (isBinary) {
        // PCM 16-bit LE mono @ 16kHz from the browser.
        if (this.upstream && this.upstream.readyState === WebSocket.OPEN) {
          this.upstream.send(data);
          chunkCount++;
          const len = (data as Buffer).length ?? 0;
          bytesSent += len;
          if (chunkCount === 1 || chunkCount % 50 === 0) {
            logger.info(
              { chunkCount, bytesSent, latestChunkBytes: len },
              "Forwarded audio chunks to AssemblyAI",
            );
          }
        }
        return;
      }
      // Text frame = JSON control message.
      let msg: ClientControl;
      try {
        msg = JSON.parse(data.toString()) as ClientControl;
      } catch {
        return;
      }
      if (msg.type === "stop") {
        void this.gracefulStop();
      } else if (msg.type === "save") {
        void this.saveTranscript(msg.title ?? "Live recording");
      }
    });

    this.client.on("close", () => {
      this.shutdown(1000, "client-closed");
    });
    this.client.on("error", (err) => {
      logger.warn({ err: err.message }, "Client WS error");
      this.shutdown(1011, "client-error");
    });
  }

  private sendToClient(payload: Record<string, unknown>): void {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(payload));
    }
  }

  private closeClient(code: number): void {
    if (
      this.client.readyState === WebSocket.OPEN ||
      this.client.readyState === WebSocket.CONNECTING
    ) {
      try {
        this.client.close(code);
      } catch {
        /* ignore */
      }
    }
  }

  private async gracefulStop(): Promise<void> {
    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) {
      try {
        this.upstream.send(JSON.stringify({ type: "Terminate" }));
      } catch {
        /* ignore */
      }
    }
  }

  private async saveTranscript(rawTitle: string): Promise<void> {
    const text = this.assembledText();
    if (!text.trim()) {
      this.sendToClient({
        type: "save_error",
        message: "Nothing to save — transcript is empty.",
      });
      return;
    }
    const title = (rawTitle || "Live recording").trim().slice(0, 280);
    try {
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const inserted = await db
        .insert(transcriptsTable)
        .values({
          title,
          text,
          originalFilename: "(live recording)",
          wordCount,
        })
        .returning();
      const saved = inserted[0];
      if (!saved) {
        this.sendToClient({
          type: "save_error",
          message: "Database did not return the saved row.",
        });
        return;
      }
      this.sendToClient({
        type: "saved",
        id: saved.id,
        title: saved.title,
        word_count: saved.wordCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown DB error";
      logger.error({ err: message }, "Failed to save live transcript");
      this.sendToClient({ type: "save_error", message });
    }
  }

  private assembledText(): string {
    const parts = [...this.finalParts];
    if (this.currentPartial.trim()) parts.push(this.currentPartial.trim());
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  private shutdown(code: number, reason: string): void {
    if (this.terminated) return;
    this.terminated = true;
    if (this.upstream) {
      try {
        if (this.upstream.readyState === WebSocket.OPEN) {
          this.upstream.send(JSON.stringify({ type: "Terminate" }));
        }
        this.upstream.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    this.closeClient(code);
  }
}

/**
 * Attach a `/api/live` WebSocket route to the existing http.Server.
 * Uses the `noServer` pattern so we can route based on URL path.
 */
export function attachLiveTranscribe(server: import("node:http").Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? "";
      // Match exact path or with query string.
      if (!url.startsWith("/api/live")) return;

      const apiKey = process.env["ASSEMBLYAI_API_KEY"];
      if (!apiKey) {
        socket.write(
          "HTTP/1.1 500 Internal Server Error\r\n\r\nASSEMBLYAI_API_KEY not configured",
        );
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const bridge = new LiveBridge(ws, apiKey);
        bridge.start();
      });
    },
  );

  logger.info("Live transcription WS route mounted at /api/live");
}
