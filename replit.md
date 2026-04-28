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
- `PATCH /transcripts/:id` (title / summary / bullets), `DELETE /transcripts/:id`
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

### Known limits / deferred
- No authentication — single-tenant prototype. CORS is open.
- Uses `multer` 1.4.5-lts.1 (deprecated upstream).
- AI calls truncate long transcripts; no map-reduce chunking yet.
- Legacy routes `/api/token`, `/api/copilot`, `/api/followup` are still mounted but unused.
