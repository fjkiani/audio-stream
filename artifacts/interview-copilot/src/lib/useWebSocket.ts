import { useRef, useCallback } from "react";

const MAX_RECONNECT = 3;

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
  enableKeyterms?: boolean;
  sessionPrompt?: string;
}

export function useWebSocket(opts: UseWebSocketOptions) {
  const { onMessage, onStatusChange, enableKeyterms = true, sessionPrompt } = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
          reconnectTimerRef.current = setTimeout(async () => {
            try {
              const tokenRes = await fetch("/api/token", { method: "POST" });
              const tokenData = (await tokenRes.json()) as { token: string };
              if (!tokenRes.ok || !tokenData.token) throw new Error("Re-auth failed");

              const newWs = new WebSocket(buildWsUrl(tokenData.token));
              wsRef.current = newWs;
              newWs.onopen = () => {
                sendConfigure(newWs);
                onStatusChange("listening");
                attachHandlers(newWs);
              };
            } catch {
              onStatusChange("error");
            }
          }, delayMs);
        } else {
          onStatusChange("error");
        }
      };
    },
    [onMessage, onStatusChange, buildWsUrl]
  );

  const connect = useCallback(
    (token: string): Promise<WebSocket> => {
      return new Promise((resolve, reject) => {
        try {
          const url = buildWsUrl(token);
          const ws = new WebSocket(url);
          wsRef.current = ws;

          ws.onopen = () => {
            isConnectedRef.current = true;
            reconnectAttemptsRef.current = 0;
            sendConfigure(ws);
            onStatusChange("listening");
            attachHandlers(ws);
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
    [buildWsUrl, onStatusChange, attachHandlers]
  );

  const disconnect = useCallback(() => {
    isConnectedRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
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
