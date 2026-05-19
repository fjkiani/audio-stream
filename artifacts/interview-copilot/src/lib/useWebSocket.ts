import { useRef, useCallback } from "react";

// Increase from 3 → 5 to give more recovery attempts on flaky networks.
const MAX_RECONNECT = 5;

// Token TTL is 600 s (API max). Refresh proactively at 80 % (480 s) so we
// never hit the expiry wall mid-session.
const TOKEN_TTL_SECONDS = 600;
const REFRESH_AT_SECONDS = TOKEN_TTL_SECONDS * 0.8; // 480 s

const DOMAIN_KEYTERMS = [
  "distributed systems", "microservices", "kubernetes", "docker",
  "React", "TypeScript", "PostgreSQL", "Redis", "Kafka",
  "API design", "system design", "load balancing", "caching",
  "eventual consistency", "CAP theorem", "ACID", "idempotent",
];

export interface WsMessage {
  type: "Begin" | "Turn" | "Termination" | "Error";
  transcript?: string;
  text?: string;
  end_of_turn?: boolean;
  is_final?: boolean;
  speaker?: string;
  speaker_label?: string;
  error?: string;
}

interface UseWebSocketOptions {
  onMessage: (msg: WsMessage) => void;
  onStatusChange: (status: string) => void;
  /** Called whenever the WebSocket is replaced (reconnect). The caller must
   *  hot-swap the audio pipeline's send target to the new socket. */
  onSocketReplaced?: (newSend: (data: ArrayBuffer) => void) => void;
  enableKeyterms?: boolean;
  sessionPrompt?: string;
}

export function useWebSocket(opts: UseWebSocketOptions) {
  const {
    onMessage,
    onStatusChange,
    onSocketReplaced,
    enableKeyterms = true,
    sessionPrompt,
  } = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isConnectedRef = useRef(false);

  const buildWsUrl = useCallback(
    (token: string) => {
      const prompt =
        sessionPrompt ||
        "Technical job interview between two speakers. Speakers may pause mid-question.";
      const params = new URLSearchParams({
        token,
        sample_rate: "16000",
        speech_model: "u3-rt-pro",
        language_detection: "true",
        speaker_labels: "true",
        prompt,
      });

      if (enableKeyterms && DOMAIN_KEYTERMS.length > 0) {
        params.append("keyterms_prompt", JSON.stringify(DOMAIN_KEYTERMS));
      }

      return `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
    },
    [enableKeyterms, sessionPrompt]
  );

  const sendConfigure = (ws: WebSocket) => {
    ws.send(
      JSON.stringify({
        type: "UpdateConfiguration",
        max_turn_silence: 6000,
        min_turn_silence: 500,
      })
    );
  };

  // Forward declaration so attachHandlers and scheduleRefresh can reference each other.
  const doReconnectRef = useRef<() => Promise<void>>();

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      if (!isConnectedRef.current) return;
      doReconnectRef.current?.();
    }, REFRESH_AT_SECONDS * 1000);
  }, []);

  const attachHandlers = useCallback(
    (ws: WebSocket) => {
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage;
          onMessage(msg);
        } catch {}
      };

      ws.onerror = () => {
        onStatusChange("error");
      };

      ws.onclose = (ev) => {
        if (!isConnectedRef.current) return;
        const code = ev?.code || 0;
        onStatusChange("disconnected");

        const NON_RECOVERABLE = [1008, 3006, 4001, 4002];
        if (NON_RECOVERABLE.includes(code)) {
          onStatusChange("error");
          return;
        }

        const attempt = reconnectAttemptsRef.current;
        if (attempt < MAX_RECONNECT) {
          const delayMs = Math.pow(2, attempt) * 1000;
          reconnectAttemptsRef.current = attempt + 1;
          reconnectTimerRef.current = setTimeout(() => {
            doReconnectRef.current?.();
          }, delayMs);
        } else {
          onStatusChange("error");
        }
      };
    },
    [onMessage, onStatusChange]
  );

  // Shared reconnect logic used by both onclose and proactive refresh.
  const doReconnect = useCallback(async () => {
    try {
      const tokenRes = await fetch("/api/token", { method: "POST" });
      const tokenData = (await tokenRes.json()) as {
        token: string;
        expires_in_seconds?: number;
      };
      if (!tokenRes.ok || !tokenData.token) throw new Error("Re-auth failed");

      const newWs = new WebSocket(buildWsUrl(tokenData.token));
      wsRef.current = newWs;

      // Wire handlers BEFORE onopen so no messages are missed.
      attachHandlers(newWs);

      newWs.onopen = () => {
        sendConfigure(newWs);
        onStatusChange("listening");
        reconnectAttemptsRef.current = 0;

        // Hot-swap the audio pipeline's send target to the new socket.
        if (onSocketReplaced) {
          onSocketReplaced((data: ArrayBuffer) => {
            if (newWs.readyState === WebSocket.OPEN) newWs.send(data);
          });
        }

        // Schedule the next proactive refresh.
        scheduleRefresh();
      };
    } catch {
      onStatusChange("error");
    }
  }, [buildWsUrl, attachHandlers, onStatusChange, onSocketReplaced, scheduleRefresh]);

  // Keep the ref in sync so the timers can call the latest closure.
  doReconnectRef.current = doReconnect;

  const connect = useCallback(
    (token: string): Promise<WebSocket> => {
      return new Promise((resolve, reject) => {
        try {
          const url = buildWsUrl(token);
          const ws = new WebSocket(url);
          wsRef.current = ws;

          // Wire handlers BEFORE onopen so no messages are missed.
          attachHandlers(ws);

          ws.onopen = () => {
            isConnectedRef.current = true;
            reconnectAttemptsRef.current = 0;
            sendConfigure(ws);
            onStatusChange("listening");
            // Schedule proactive token refresh at 80 % of TTL.
            scheduleRefresh();
            resolve(ws);
          };

          ws.onerror = () => {
            reject(new Error("WebSocket connection failed"));
          };
        } catch (err) {
          reject(err);
        }
      });
    },
    [buildWsUrl, onStatusChange, attachHandlers, scheduleRefresh]
  );

  const disconnect = useCallback(() => {
    isConnectedRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    try {
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "Terminate" }));
        }
        wsRef.current.close();
        wsRef.current = null;
      }
    } catch {}
  }, []);

  const send = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  return { wsRef, connect, disconnect, send };
}
