import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

type Status =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "live"
  | "reconnecting"
  | "stopping"
  | "stopped"
  | "error";

const MAX_RECONNECT_ATTEMPTS = 10;

interface FinalSegment {
  id: number;
  text: string;
}

interface ServerMsg {
  type: string;
  text?: string;
  turn_order?: number;
  message?: string;
  audio_duration_seconds?: number | null;
  id?: string;
  title?: string;
  word_count?: number;
}

interface LivePanelProps {
  onSaved: (id: string) => void;
}

const PCM_WORKLET_URL = `${import.meta.env.BASE_URL}audio-processor.js`;

function buildWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/live`;
}

export default function LivePanel({ onSaved }: LivePanelProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const [finals, setFinals] = useState<FinalSegment[]>([]);
  const [title, setTitle] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  // Reconnection state. `intentionalCloseRef` tells the onclose handler not
  // to try and recover (because the user pressed Stop or unmounted). The
  // attempt counter and pending timer drive exponential backoff.
  // `connectingRef` is a single-flight guard so visibilitychange / backoff
  // / online events can't race to spawn duplicate sockets.
  const intentionalCloseRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const chunkCountRef = useRef(0);
  const connectingRef = useRef(false);
  const stopFallbackRef = useRef<number | null>(null);

  /** Just close the WebSocket. Used during reconnect and full cleanup. */
  const closeWs = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        if (
          wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING
        ) {
          wsRef.current.close();
        }
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
  }, []);

  /** Hard tear-down of every audio + WS resource. Safe to call repeatedly. */
  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (stopFallbackRef.current !== null) {
      window.clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
    }
    connectingRef.current = false;
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (nodeRef.current) {
      try {
        nodeRef.current.port.onmessage = null;
        nodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
      nodeRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        /* ignore */
      }
      sourceRef.current = null;
    }
    if (sinkRef.current) {
      try {
        sinkRef.current.disconnect();
      } catch {
        /* ignore */
      }
      sinkRef.current = null;
    }
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    closeWs();
  }, [closeWs]);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  /**
   * Open (or re-open) the WebSocket to our `/api/live` bridge and wire it to
   * the existing audio graph. Safe to call after a transient disconnect: the
   * mic stream, AudioContext, and worklet node are reused; only the WS and
   * its message pump are rebuilt. Server creates a fresh AssemblyAI session
   * on each connection — accumulated `finals` are kept on the client.
   */
  const openWs = useCallback(
    (isReconnect: boolean) => {
      const ctx = ctxRef.current;
      const node = nodeRef.current;
      if (!ctx || !node) return;
      // Single-flight guard: only one in-flight WS open at a time. Stops
      // visibilitychange / online / backoff timer / manual events from
      // racing to spawn duplicate sockets.
      if (connectingRef.current) return;
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      connectingRef.current = true;

      setStatus(isReconnect ? "reconnecting" : "connecting");
      const ws = new WebSocket(buildWsUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        connectingRef.current = false;
        // Reset the backoff counter on any successful open.
        reconnectAttemptsRef.current = 0;
        // Make sure the audio graph is actually running. Browsers will
        // auto-suspend the AudioContext when the tab is backgrounded; the
        // visibilitychange handler also calls resume(), but doing it on every
        // open is cheap insurance.
        if (ctx.state === "suspended") {
          void ctx.resume();
        }
        // Wire / re-wire the worklet → WS pipe.
        node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
          const sock = wsRef.current;
          if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(ev.data);
            chunkCountRef.current++;
            if (
              chunkCountRef.current === 1 ||
              chunkCountRef.current % 50 === 0
            ) {
              // eslint-disable-next-line no-console
              console.log(
                `[live] sent ${chunkCountRef.current} audio chunks (latest=${ev.data.byteLength}B)`,
              );
            }
          }
        };
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data) as ServerMsg;
        } catch {
          return;
        }
        switch (msg.type) {
          case "ready":
            break;
          case "begin":
            setStatus("live");
            if (startedAtRef.current === null) {
              startedAtRef.current = Date.now();
            }
            // eslint-disable-next-line no-console
            console.log("[live] AssemblyAI session begin");
            break;
          case "partial":
            setPartial(msg.text ?? "");
            break;
          case "final":
            if ((msg.text ?? "").trim()) {
              setFinals((prev) => [
                ...prev,
                {
                  // unique id — turn_order resets on each new upstream
                  // session, so namespace by current array length.
                  id: prev.length,
                  text: msg.text!,
                },
              ]);
            }
            setPartial("");
            break;
          case "error":
            setErrorMsg(msg.message ?? "Live transcription error.");
            setStatus("error");
            intentionalCloseRef.current = true;
            break;
          case "upstream_closed":
            // AssemblyAI closed our upstream session. The server will close
            // our client WS too, which triggers ws.onclose → reconnect.
            // Surface a soft message rather than a hard error.
            // eslint-disable-next-line no-console
            console.log("[live] upstream closed:", msg);
            break;
          case "terminated":
            // Only treat as final stop if WE asked to stop.
            if (intentionalCloseRef.current) setStatus("stopped");
            break;
        }
      };

      ws.onerror = () => {
        // Don't surface as a hard error here — `onclose` will fire next and
        // the reconnect logic decides what to do.
        // eslint-disable-next-line no-console
        console.warn("[live] WebSocket error (will attempt reconnect)");
      };

      ws.onclose = () => {
        connectingRef.current = false;
        // If the user (or unmount/error) initiated this, do nothing.
        if (intentionalCloseRef.current) {
          setStatus((s) => (s === "stopping" ? "stopped" : s));
          return;
        }
        // Otherwise: schedule a reconnect with exponential backoff.
        const attempt = ++reconnectAttemptsRef.current;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          setErrorMsg(
            "Lost connection and could not reconnect. Please save what you have and start a new session.",
          );
          setStatus("error");
          intentionalCloseRef.current = true;
          cleanup();
          return;
        }
        const delay = Math.min(15000, 500 * 2 ** Math.min(attempt - 1, 5));
        setStatus("reconnecting");
        // eslint-disable-next-line no-console
        console.warn(
          `[live] connection dropped, reconnect attempt ${attempt} in ${delay}ms`,
        );
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          openWs(true);
        }, delay);
      };
    },
    [cleanup],
  );

  const start = useCallback(async () => {
    setErrorMsg(null);
    setSavedId(null);
    savedWordCountRef.current = 0;
    setFinals([]);
    setPartial("");
    setElapsed(0);
    setStatus("requesting-mic");
    intentionalCloseRef.current = false;
    reconnectAttemptsRef.current = 0;
    chunkCountRef.current = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // AudioContext at 16kHz when supported (Chromium honours this; Safari
      // ignores and runs at hardware rate — the worklet handles downsampling).
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: 16000 });
      } catch {
        ctx = new AudioContext();
      }
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule(PCM_WORKLET_URL);

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const node = new AudioWorkletNode(ctx, "pcm-processor");
      nodeRef.current = node;
      source.connect(node);
      // CRITICAL: a Web Audio node only runs if it has a path to the
      // AudioContext destination. Route the worklet through a muted gain
      // into the speakers — keeps the worklet alive without any audible
      // loopback.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sinkRef.current = sink;
      node.connect(sink);
      sink.connect(ctx.destination);
      // eslint-disable-next-line no-console
      console.log(
        "[live] AudioContext sampleRate:",
        ctx.sampleRate,
        "state:",
        ctx.state,
      );

      // Cheap volume meter + elapsed-time tick.
      try {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const sample = () => {
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i] - 128);
            if (v > peak) peak = v;
          }
          setAudioLevel(Math.min(1, peak / 64));
        };
        tickRef.current = window.setInterval(() => {
          sample();
          if (startedAtRef.current !== null) {
            setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
          }
        }, 100);
      } catch {
        /* ignore meter failures */
      }

      openWs(false);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not start microphone.";
      setErrorMsg(msg);
      setStatus("error");
      intentionalCloseRef.current = true;
      cleanup();
    }
  }, [cleanup, openWs]);

  const stop = useCallback(() => {
    setStatus("stopping");
    // Critical: mark this as an intentional close BEFORE we touch the WS, so
    // our onclose handler doesn't try to reconnect.
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
    // Stop pumping mic audio immediately, but keep WS alive so the
    // upstream Termination message can come back. The fallback timer
    // (5s) guarantees cleanup even if AssemblyAI never replies.
    if (nodeRef.current) {
      try {
        nodeRef.current.port.onmessage = null;
        nodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    if (stopFallbackRef.current !== null) {
      window.clearTimeout(stopFallbackRef.current);
    }
    stopFallbackRef.current = window.setTimeout(() => {
      cleanup();
      setStatus((s) => (s === "stopping" ? "stopped" : s));
      stopFallbackRef.current = null;
    }, 5000);
  }, [cleanup]);

  // Cancel the fallback timer if cleanup happens earlier (e.g. on
  // "terminated"/"upstream_closed" we close the WS in onclose, which
  // calls cleanup before the 5s elapse).
  useEffect(() => {
    if (status === "stopped" && stopFallbackRef.current !== null) {
      window.clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
      cleanup();
    }
  }, [status, cleanup]);

  // Keep the audio graph alive when the user backgrounds the tab. Browsers
  // will auto-suspend AudioContext, which silently stops the worklet — that
  // alone doesn't drop the WS, but if the WS does drop we want to be ready
  // to reconnect immediately when the user returns. Also force a reconnect
  // on `online` events so a Wi-Fi blip recovers fast.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const ctx = ctxRef.current;
      if (ctx && ctx.state === "suspended") {
        void ctx.resume();
      }
      // If the WS happens to be closed and we're mid-session, kick a
      // reconnect now instead of waiting for the backoff timer.
      const ws = wsRef.current;
      if (
        !intentionalCloseRef.current &&
        nodeRef.current &&
        ctx &&
        (!ws || ws.readyState === WebSocket.CLOSED)
      ) {
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        openWs(true);
      }
    };
    const onOnline = () => onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [openWs]);

  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    // Always save via HTTP — no dependency on the live WebSocket. Works
    // mid-session, after Stop, or after the upstream closed unexpectedly.
    const text = finals
      .map((f) => f.text)
      .join(" ")
      .trim();
    if (!text) {
      setErrorMsg("Nothing to save — transcript is empty.");
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    try {
      const seconds =
        startedAtRef.current !== null
          ? Math.max(1, Math.floor((Date.now() - startedAtRef.current) / 1000))
          : null;
      // If we already saved once and the user is "saving again" to capture
      // late finals, PATCH the existing row instead of creating a duplicate.
      if (savedId) {
        await api.patch(savedId, {
          text,
          ...(title.trim() ? { title: title.trim() } : {}),
        });
        savedWordCountRef.current = text.split(/\s+/).filter(Boolean).length;
        onSaved(savedId);
      } else {
        const created = await api.create({
          title: title.trim() || undefined,
          text,
          source: "(live recording)",
          audio_duration: seconds,
        });
        savedWordCountRef.current = text.split(/\s+/).filter(Boolean).length;
        setSavedId(created.id);
        onSaved(created.id);
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to save transcript.");
    } finally {
      setSaving(false);
    }
  }, [finals, title, onSaved]);

  const reset = useCallback(() => {
    intentionalCloseRef.current = true;
    reconnectAttemptsRef.current = 0;
    chunkCountRef.current = 0;
    cleanup();
    setStatus("idle");
    setFinals([]);
    setPartial("");
    setErrorMsg(null);
    setSavedId(null);
    savedWordCountRef.current = 0;
    setTitle("");
    setElapsed(0);
    setAudioLevel(0);
    startedAtRef.current = null;
  }, [cleanup]);

  const fullText = finals.map((f) => f.text).join(" ").trim();
  const isRunning =
    status === "live" ||
    status === "connecting" ||
    status === "requesting-mic" ||
    status === "reconnecting";
  // Save is now an HTTP call, so it works whether we're still streaming or
  // already stopped — as long as we have some finalised text and aren't
  // already saving. We deliberately allow re-save after an initial save: if
  // late `final` segments arrive after the first save (common around
  // Stop/termination boundaries) the user can capture them with another
  // click rather than losing them.
  const canSave = fullText.length > 0 && !saving;
  const fullWordCount = fullText ? fullText.split(/\s+/).filter(Boolean).length : 0;
  const savedWordCountRef = useRef(0);
  const hasNewSinceSave = savedId !== null && fullWordCount > savedWordCountRef.current;

  function statusLabel(): string {
    switch (status) {
      case "idle":
        return "Ready";
      case "requesting-mic":
        return "Requesting microphone…";
      case "connecting":
        return "Connecting to AssemblyAI…";
      case "live":
        return "● Live";
      case "reconnecting":
        return "Reconnecting…";
      case "stopping":
        return "Stopping…";
      case "stopped":
        return "Stopped";
      case "error":
        return "Error";
    }
  }

  function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="lv-shell">
      <header className="lv-head">
        <div>
          <h2>Live transcription</h2>
          <p className="lv-subtitle">
            Capture meetings or any audio from your microphone in real time
            with AssemblyAI.
          </p>
        </div>
        <div className={`lv-status lv-status--${status}`}>
          {statusLabel()}
          {(status === "live" || status === "stopped") && (
            <span className="lv-elapsed"> · {fmtTime(elapsed)}</span>
          )}
        </div>
      </header>

      <div className="lv-controls">
        {!isRunning && status !== "stopping" && (
          <button
            type="button"
            className="btn-primary lv-rec"
            onClick={() => void start()}
          >
            <span className="lv-rec-dot" /> Start recording
          </button>
        )}
        {isRunning && (
          <button type="button" className="btn-danger" onClick={stop}>
            ■ Stop
          </button>
        )}
        {status === "stopped" && (
          <button type="button" className="btn-ghost" onClick={reset}>
            ↺ New session
          </button>
        )}

        <div className="lv-meter" aria-label="Microphone level">
          <div
            className="lv-meter-fill"
            style={{ width: `${Math.round(audioLevel * 100)}%` }}
          />
        </div>
      </div>

      {errorMsg && <div className="ux-error">⚠ {errorMsg}</div>}

      <section className="lv-transcript">
        <div className="lv-transcript-head">
          <span>Transcript</span>
          {fullText.length > 0 && (
            <span className="lv-wordcount">
              {fullText.split(/\s+/).filter(Boolean).length} words
            </span>
          )}
        </div>

        {finals.length === 0 && !partial && (
          <div className="lv-empty">
            {status === "live"
              ? "Listening… start speaking and finalised text will appear here."
              : status === "idle"
                ? "Click Start recording to begin a live session."
                : "—"}
          </div>
        )}

        <div className="lv-transcript-body">
          {finals.map((f) => (
            <p key={f.id} className="lv-final">
              {f.text}
            </p>
          ))}
          {partial && <p className="lv-partial">{partial}</p>}
        </div>
      </section>

      {(status === "live" || status === "stopped") && (
        <footer className="lv-save">
          <input
            type="text"
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="lv-title-input"
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => void save()}
            disabled={!canSave}
            title={
              fullText.length === 0
                ? "Nothing to save yet — speak first"
                : hasNewSinceSave
                  ? "Update saved transcript with new finalised text"
                  : savedId
                    ? "Already up to date"
                    : "Save to library"
            }
          >
            {saving
              ? "Saving…"
              : !savedId
                ? "⤓ Save to library"
                : hasNewSinceSave
                  ? "↻ Update saved"
                  : "✓ Saved"}
          </button>
          {savedId && !hasNewSinceSave && (
            <span className="lv-saved-ok">✓ Saved · opens in library</span>
          )}
          {savedId && hasNewSinceSave && (
            <span className="lv-saved-ok">
              + {fullWordCount - savedWordCountRef.current} new words since save
            </span>
          )}
        </footer>
      )}
    </div>
  );
}
