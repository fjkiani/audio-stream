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

Pivoted from the real-time Interview Copilot into a focused upload-and-transcribe app.
Frontend: drag-and-drop or browse → upload → transcript displayed with copy/download.

### Features
- **File upload** with progress (XHR for upload-progress events)
- **Drag-and-drop** support
- **AssemblyAI batch transcription** (universal-2 model) via the `/api/transcribe` route
- **Copy to clipboard** and **download as .txt**
- 200 MB max file size, accepts audio and video formats

### API Routes (api-server)
- `GET  /api/healthz` — health check
- `POST /api/transcribe` — multipart/form-data upload, field name `audio`. Returns
  `{ id, text, audio_duration, language_code, word_count, original_filename, original_size }`.
  Optional form fields: `speaker_labels`, `punctuate`, `format_text`.
- (Legacy, unused by current UI but still mounted: `/api/token`, `/api/copilot`, `/api/followup`.)

### Required Secrets
- `ASSEMBLYAI_API_KEY` — for the batch transcription API

### Key Files
- `artifacts/api-server/src/routes/transcribe.ts` — upload + poll AssemblyAI job
- `artifacts/interview-copilot/src/pages/TranscribePage.tsx` — upload UI / progress / result
- `artifacts/interview-copilot/src/index.css` — `tx-*` styles for the new UI
