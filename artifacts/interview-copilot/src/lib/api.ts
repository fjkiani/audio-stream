// Shared types + API helpers for the Scribe app

export interface TranscriptListItem {
  id: string;
  title: string;
  original_filename: string;
  audio_duration: number | null;
  language_code: string | null;
  word_count: number;
  summary_excerpt: string | null;
  text_excerpt: string;
  created_at: string;
}

export interface TranscriptRelation {
  id: string;
  direction: "outgoing" | "incoming";
  kind: RelationKind;
  note: string | null;
  other_id: string;
  other_title: string;
  created_at: string;
}

export interface TranscriptDetail {
  id: string;
  title: string;
  text: string;
  original_filename: string;
  audio_duration: number | null;
  language_code: string | null;
  word_count: number;
  summary: string | null;
  bullets: string[] | null;
  created_at: string;
  updated_at: string;
  relations: TranscriptRelation[];
}

export const RELATION_KINDS = [
  "related",
  "follow_up",
  "continues",
  "elaborates",
  "contradicts",
  "references",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export const RELATION_LABELS: Record<RelationKind, string> = {
  related: "related to",
  follow_up: "follow-up to",
  continues: "continues",
  elaborates: "elaborates on",
  contradicts: "contradicts",
  references: "references",
};

async function jsonOrThrow<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (!res.ok) {
    const errMsg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}

export const api = {
  list: () =>
    jsonOrThrow<{ transcripts: TranscriptListItem[] }>(fetch("/api/transcripts")),

  get: (id: string) => jsonOrThrow<TranscriptDetail>(fetch(`/api/transcripts/${id}`)),

  create: (body: {
    title?: string;
    text: string;
    source?: string;
    language_code?: string | null;
    audio_duration?: number | null;
  }) =>
    jsonOrThrow<{ id: string; title: string; word_count: number }>(
      fetch(`/api/transcripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ),

  patch: (
    id: string,
    body: {
      title?: string;
      text?: string;
      summary?: string | null;
      bullets?: string[] | null;
    },
  ) =>
    jsonOrThrow<{ ok: true }>(
      fetch(`/api/transcripts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ),

  remove: (id: string) =>
    jsonOrThrow<{ ok: true }>(
      fetch(`/api/transcripts/${id}`, { method: "DELETE" })
    ),

  summarize: (id: string, mode: "summary" | "bullets") =>
    jsonOrThrow<{ summary?: string; bullets?: string[] }>(
      fetch(`/api/transcripts/${id}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, save: true }),
      })
    ),

  createRelation: (
    fromId: string,
    body: { to_id: string; kind: RelationKind; note?: string | null }
  ) =>
    jsonOrThrow<{ relation: { id: string } }>(
      fetch(`/api/transcripts/${fromId}/relations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ),

  deleteRelation: (relId: string) =>
    jsonOrThrow<{ ok: true }>(
      fetch(`/api/relations/${relId}`, { method: "DELETE" })
    ),
};

export interface ChatStreamHandlers {
  onMeta?: (meta: { related_count: number }) => void;
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

export function streamChat(
  id: string,
  body: { question: string; include_related: boolean },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  return fetch(`/api/transcripts/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }).then(async (res) => {
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      handlers.onError(text || `HTTP ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIdx;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const lines = block.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (event === "meta" && handlers.onMeta) {
            handlers.onMeta(parsed as { related_count: number });
          } else if (event === "token") {
            handlers.onToken(String(parsed.token ?? ""));
          } else if (event === "done") {
            handlers.onDone();
            return;
          } else if (event === "error") {
            handlers.onError(String(parsed.error ?? "stream error"));
            return;
          }
        } catch {
          // ignore
        }
      }
    }
    handlers.onDone();
  });
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
