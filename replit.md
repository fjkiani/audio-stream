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

## Interview Copilot (artifacts/interview-copilot)

Real-time AI interview assistant. Cloned and improved from fjkiani/assembly-ai-tts-v2.

### Features
- **AssemblyAI streaming STT** — WebSocket via `u3-rt-pro` model with speaker diarization
- **AudioWorklet audio pipeline** — replaced deprecated ScriptProcessorNode for reliable PCM16 capture
- **Progressive LLM streaming** — tokens appear one-by-one with animated structured sections
- **Groq LLM** — Llama 3.3 70B with SSE streaming via `/api/copilot`
- **Rescue mode** — SPACE key bypasses debounce for instant AI help when frozen
- **Burn context** — BACKSPACE flushes active context
- **Bookend memory** — first 2 + last 4 turns sent as history

### API Routes (api-server)
- `POST /api/token` — generates AssemblyAI short-lived token for browser WS
- `POST /api/copilot` — SSE streaming LLM response (Groq)
- `POST /api/followup` — SSE follow-up question generator

### Required Secrets
- `ASSEMBLYAI_API_KEY` — for real-time audio transcription
- `GROQ_API_KEY` — for LLM coaching responses

### Key Fixes vs Original
1. **Audio**: AudioWorkletNode (audio thread) replaces ScriptProcessorNode (main thread)
   - File: `artifacts/interview-copilot/public/audio-processor.js` (worklet processor)
   - File: `artifacts/interview-copilot/src/lib/useAudioCapture.ts`
2. **Progressive streaming**: Tokens render immediately with section-level parsing
   - File: `artifacts/interview-copilot/src/lib/useCopilotStream.ts`
   - File: `artifacts/interview-copilot/src/components/StreamingSection.tsx`
