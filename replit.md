# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Scribe — Audio File Transcriber (artifacts/interview-copilot)

Audio-file transcription app built on AssemblyAI (universal-2 batch model) with
a saved library, AI assistant, and links between transcripts.

### Features
- **Upload + transcribe**: drag-and-drop or browse, 200 MB max, audio + video.
  Auto-saved to a Postgres-backed library on completion.
- **Library**: sidebar list with search, quick metadata + AI summary excerpt.
- **Detail view**: editable title, copy/export, delete.
- **AI Assistant** (Groq · llama-3.3-70b-versatile):
  - Summarize (3–6 sentence prose)
  - Bullet points (4–10 key points)
  - Ask the AI — streaming Q&A over the transcript (SSE)
- **Relationships** between transcripts. Kinds: related, follow_up, continues,
  elaborates, contradicts, references. Linked transcripts are optionally pulled
  in as additional context for chat (capped at 4).

### Backend Routes (api-server, all under `/api`)
- `POST /transcribe` — multipart upload, runs AssemblyAI, persists, returns `{ id, ... }`.
- `GET  /transcripts`, `GET /transcripts/:id`
- `POST /transcripts` body `{ title?, text, source?, language_code?, audio_duration? }` — create from raw text (used by live save and any future paste/import flow); auto-counts words.
- `PATCH /transcripts/:id` (title / `text` / summary / bullets) — when `text` is updated, `word_count` is recomputed server-side. `DELETE /transcripts/:id`
- `POST /transcripts/:id/summarize` body `{ mode: "summary"|"bullets", save? }`
- `POST /transcripts/:id/relations` body `{ to_id, kind, note? }` (rejects self-link
  and duplicate pairs in either direction with the same kind, returning 409).
- `DELETE /relations/:relId`
- `POST /transcripts/:id/chat` body `{ question, include_related? }` — SSE
  events `meta`, `token`, `done`, `error`.

UUID params are validated server-side; bad params return 400 not 500. Text
passed to the LLM is truncated to safe upper bounds (60k chars primary,
12k chars per related transcript).

### Required Secrets
- `ASSEMBLYAI_API_KEY` — batch transcription
- `GROQ_API_KEY` — summarize / bullets / chat
- `DATABASE_URL` — Postgres for the library

### DB schema (lib/db/src/schema)
- `transcripts` — uuid id, title, text, original_filename, audio_duration,
  language_code, word_count, summary, bullets (jsonb), assemblyai_id, timestamps.
- `transcript_relations` — uuid id, from_id, to_id, kind, note, created_at.
  Cascade-deletes when either side is deleted.

### Key Files
- `artifacts/api-server/src/routes/transcribe.ts` — upload + AssemblyAI + save
- `artifacts/api-server/src/routes/transcripts.ts` — CRUD + AI + relations + SSE
- `artifacts/api-server/src/lib/groq.ts` — Groq complete + stream helpers
- `artifacts/interview-copilot/src/pages/TranscribePage.tsx` — top-level layout
- `artifacts/interview-copilot/src/components/{Sidebar,UploadPanel,DetailView,RelationsPanel,AskPanel}.tsx`
- `artifacts/interview-copilot/src/lib/api.ts` — typed client + SSE parser
- `artifacts/interview-copilot/src/index.css` — `sb-*`, `up-*`, `dv-*`, `rel-*`, `ask-*`, `ai-*` styles

### Live transcription (AssemblyAI streaming)
A third tab — **LIVE** — captures audio from the user's microphone and
streams it to AssemblyAI's real-time API in real time. Partial words appear
as you speak; finalised segments become permanent paragraphs.

Wire-up:
- Frontend: `getUserMedia` → `AudioContext` → `AudioWorkletNode`
  (`public/audio-processor.js`) downsamples to 16 kHz mono Int16 PCM and posts
  ArrayBuffer chunks to a `WebSocket` at `/api/live`.
- Backend: `attachLiveTranscribe(server)` in `artifacts/api-server/src/lib/assemblyLive.ts`
  attaches a `ws.WebSocketServer` (noServer pattern) to the http.Server in
  `index.ts`. Each client connection opens an upstream WS to
  `wss://streaming.assemblyai.com/v3/ws` (auth via `ASSEMBLYAI_API_KEY` header),
  forwards binary audio frames, and forwards `Begin`/`Turn`/`Termination`
  JSON messages back to the client.
- Save: client uses HTTP `POST /api/transcripts` (and re-saves via `PATCH
  /api/transcripts/:id` to capture late `final` segments). This works during
  recording AND after Stop. The frontend then jumps to the library detail
  view of the new transcript.

Resilience (added to fix “chokes after a few minutes”):
- Each successful WS open resets a backoff counter. On any *unexpected* close
  (network blip, vite HMR, server-side `client-closed`, AssemblyAI idle
  timeout, etc.), `LivePanel` schedules an exponential backoff reconnect
  (500 ms → 15 s, max 10 attempts) and re-opens the WS without recreating
  the mic stream / AudioContext / worklet — so accumulated `finals` survive
  the gap. Server creates a fresh AssemblyAI session on each reconnect.
- An `intentionalCloseRef` flag is set in `stop()` / `reset()` / unmount
  paths so user-initiated closes never trigger a reconnect.
- A `connectingRef` single-flight guard prevents duplicate sockets when
  visibilitychange / online / backoff timer events race.
- `visibilitychange` and `online` listeners resume the AudioContext (which
  browsers auto-suspend in background tabs) and force an immediate reconnect
  when the WS is closed.
- A new `reconnecting` status (amber pill, `.lv-status--reconnecting`) is
  shown to the user during recovery.

Key files:
- `artifacts/api-server/src/lib/assemblyLive.ts`
- `artifacts/interview-copilot/src/components/LivePanel.tsx`
- `artifacts/interview-copilot/public/audio-processor.js`
- styles under `.lv-*` in `src/index.css`

Limitations:
- `originalFilename` for live rows is hard-coded to `"(live recording)"`.
- AssemblyAI's v3 streaming requires PAYG; if the key isn't enabled, the
  upstream returns close-code 4xx and the UI surfaces an error toast.

### Markdown → PDF (CrisPRO.ai branded)
A second mode in the same app, accessed from the "DOC → PDF" tab in the
sidebar header.

- Upload a `.md` / `.markdown` / `.txt` file (or paste markdown into the editor).
- Live A4 preview with auto-injected header: **CrisPRO.ai 🧬** + `Contact@CrisPRO.ai`.
- Renders headings, lists, bold/italic, links, code, blockquotes, tables (CommonMark + GFM).
- Click **Download PDF** — generation runs entirely in the browser via
  `marked` + lazily-imported `html2pdf.js` (html2canvas + jsPDF). No server round-trip.

Key files:
- `artifacts/interview-copilot/src/components/DocToPdfPanel.tsx`
- styles under `.dp-*` and `.app-tabs` / `.app-tab` in `src/index.css`

### Known limits / deferred
- No authentication — single-tenant prototype. CORS is open.
- Uses `multer` 1.4.5-lts.1 (deprecated upstream).
- AI calls truncate long transcripts; no map-reduce chunking yet.
- Legacy routes `/api/token`, `/api/copilot`, `/api/followup` are still mounted but unused.
