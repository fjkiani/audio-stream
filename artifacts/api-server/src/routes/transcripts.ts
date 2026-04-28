import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { eq, desc, or, inArray, and } from "drizzle-orm";
import {
  db,
  transcriptsTable,
  transcriptRelationsTable,
  RELATION_KINDS,
  type RelationKind,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { groqComplete, groqStream } from "../lib/groq";

const router: IRouter = Router();

// ─── helpers ──────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pull a UUID param off the request, sending a 400 on bad input. */
function uuidParam(
  req: Request,
  res: Response,
  name: string,
): string | null {
  const raw = req.params[name];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== "string" || !UUID_RE.test(val)) {
    res.status(400).json({ error: `Invalid ${name}` });
    return null;
  }
  return val;
}

function trimExcerpt(text: string, max = 220): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

/** Hard upper bound for text passed to the LLM (~ a few thousand tokens). */
const AI_MAX_PRIMARY_CHARS = 60_000;
const AI_MAX_RELATED_CHARS = 12_000;

function truncateForAI(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text:
      text.slice(0, max) +
      `\n\n[... transcript truncated; ${text.length - max} characters omitted for length ...]`,
    truncated: true,
  };
}

async function getTranscriptOr404(
  id: string,
  res: Response,
): Promise<typeof transcriptsTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(transcriptsTable)
    .where(eq(transcriptsTable.id, id))
    .limit(1);
  if (!rows.length) {
    res.status(404).json({ error: "Transcript not found" });
    return null;
  }
  return rows[0];
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

router.get("/transcripts", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: transcriptsTable.id,
        title: transcriptsTable.title,
        originalFilename: transcriptsTable.originalFilename,
        audioDuration: transcriptsTable.audioDuration,
        languageCode: transcriptsTable.languageCode,
        wordCount: transcriptsTable.wordCount,
        summary: transcriptsTable.summary,
        text: transcriptsTable.text,
        createdAt: transcriptsTable.createdAt,
      })
      .from(transcriptsTable)
      .orderBy(desc(transcriptsTable.createdAt));

    const list = rows.map((r) => ({
      id: r.id,
      title: r.title,
      original_filename: r.originalFilename,
      audio_duration: r.audioDuration,
      language_code: r.languageCode,
      word_count: r.wordCount,
      summary_excerpt: r.summary ? trimExcerpt(r.summary, 160) : null,
      text_excerpt: trimExcerpt(r.text, 200),
      created_at: r.createdAt.toISOString(),
    }));

    res.json({ transcripts: list });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: msg }, "List transcripts failed");
    res.status(500).json({ error: msg });
  }
});

// ─── GET ONE (with relations) ────────────────────────────────────────────────

router.get("/transcripts/:id", async (req: Request, res: Response) => {
  const id = uuidParam(req, res, "id");
  if (!id) return;
  try {
    const t = await getTranscriptOr404(id, res);
    if (!t) return;

    const relations = await db
      .select()
      .from(transcriptRelationsTable)
      .where(
        or(
          eq(transcriptRelationsTable.fromId, t.id),
          eq(transcriptRelationsTable.toId, t.id),
        ),
      );

    const otherIds = Array.from(
      new Set(
        relations.flatMap((r) => [r.fromId, r.toId]).filter((id) => id !== t.id),
      ),
    );

    const others = otherIds.length
      ? await db
          .select({
            id: transcriptsTable.id,
            title: transcriptsTable.title,
            wordCount: transcriptsTable.wordCount,
            createdAt: transcriptsTable.createdAt,
          })
          .from(transcriptsTable)
          .where(inArray(transcriptsTable.id, otherIds))
      : [];

    const otherMap = new Map(others.map((o) => [o.id, o]));

    res.json({
      id: t.id,
      title: t.title,
      text: t.text,
      original_filename: t.originalFilename,
      audio_duration: t.audioDuration,
      language_code: t.languageCode,
      word_count: t.wordCount,
      summary: t.summary,
      bullets: t.bullets,
      created_at: t.createdAt.toISOString(),
      updated_at: t.updatedAt.toISOString(),
      relations: relations.map((r) => {
        const isOutgoing = r.fromId === t.id;
        const otherId = isOutgoing ? r.toId : r.fromId;
        const other = otherMap.get(otherId);
        return {
          id: r.id,
          direction: isOutgoing ? "outgoing" : "incoming",
          kind: r.kind,
          note: r.note,
          other_id: otherId,
          other_title: other?.title ?? "(deleted)",
          created_at: r.createdAt.toISOString(),
        };
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: msg }, "Get transcript failed");
    res.status(500).json({ error: msg });
  }
});

// ─── PATCH (update title) ────────────────────────────────────────────────────

const PatchBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  summary: z.string().nullable().optional(),
  bullets: z.array(z.string()).nullable().optional(),
});

router.patch("/transcripts/:id", async (req: Request, res: Response) => {
  const id = uuidParam(req, res, "id");
  if (!id) return;
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const t = await getTranscriptOr404(id, res);
    if (!t) return;

    const updates: Partial<typeof transcriptsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsed.data.title !== undefined) updates.title = parsed.data.title;
    if (parsed.data.summary !== undefined) updates.summary = parsed.data.summary;
    if (parsed.data.bullets !== undefined) updates.bullets = parsed.data.bullets;

    await db
      .update(transcriptsTable)
      .set(updates)
      .where(eq(transcriptsTable.id, t.id));
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

router.delete("/transcripts/:id", async (req: Request, res: Response) => {
  const id = uuidParam(req, res, "id");
  if (!id) return;
  try {
    const t = await getTranscriptOr404(id, res);
    if (!t) return;
    await db.delete(transcriptsTable).where(eq(transcriptsTable.id, t.id));
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ─── SUMMARIZE / BULLETS ─────────────────────────────────────────────────────

const SummarizeBody = z.object({
  mode: z.enum(["summary", "bullets"]),
  save: z.boolean().optional().default(true),
});

const SUMMARY_PROMPT = `You are an expert summarizer. Read the transcript and produce a tight, faithful summary.
Rules:
- 3-6 sentences, plain prose, no headings.
- Preserve named entities, numbers, decisions, and questions.
- Do not invent details that are not in the transcript.
- If the transcript is short or empty, say so honestly.
- If the transcript was truncated for length, summarize what is provided and note the truncation in one sentence.`;

const BULLETS_PROMPT = `You are an expert note-taker. Read the transcript and extract the key points as bullets.
Output STRICT JSON only — an array of strings — no preamble, no fences, no extra keys.
Rules:
- 4-10 bullets, each one short, full sentence, action- or fact-oriented.
- Cover the most important ideas, decisions, questions, numbers, names.
- Do not invent details. If the transcript has no content, return an empty array [].`;

router.post(
  "/transcripts/:id/summarize",
  async (req: Request, res: Response): Promise<void> => {
    const id = uuidParam(req, res, "id");
    if (!id) return;
    const parsed = SummarizeBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }
    try {
      const t = await getTranscriptOr404(id, res);
      if (!t) return;

      if (!t.text.trim()) {
        res.status(400).json({ error: "Transcript is empty" });
        return;
      }

      const { text: bodyText } = truncateForAI(t.text, AI_MAX_PRIMARY_CHARS);
      const systemPrompt =
        parsed.data.mode === "bullets" ? BULLETS_PROMPT : SUMMARY_PROMPT;
      const userPrompt = `Title: ${t.title}\n\nTranscript:\n${bodyText}`;

      const out = await groqComplete({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: parsed.data.mode === "bullets" ? 800 : 600,
      });

      if (parsed.data.mode === "bullets") {
        let bullets: string[] = [];
        try {
          const cleaned = out
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();
          const parsedJson = JSON.parse(cleaned);
          if (Array.isArray(parsedJson)) {
            bullets = parsedJson.filter((b): b is string => typeof b === "string");
          }
        } catch {
          bullets = out
            .split("\n")
            .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
            .filter((l) => l.length > 0);
        }
        if (parsed.data.save) {
          await db
            .update(transcriptsTable)
            .set({ bullets, updatedAt: new Date() })
            .where(eq(transcriptsTable.id, t.id));
        }
        res.json({ bullets });
      } else {
        if (parsed.data.save) {
          await db
            .update(transcriptsTable)
            .set({ summary: out, updatedAt: new Date() })
            .where(eq(transcriptsTable.id, t.id));
        }
        res.json({ summary: out });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err: msg }, "Summarize failed");
      res.status(500).json({ error: msg });
    }
  },
);

// ─── RELATIONS ───────────────────────────────────────────────────────────────

const CreateRelationBody = z.object({
  to_id: z.string().uuid(),
  kind: z.enum(RELATION_KINDS).default("related"),
  note: z.string().max(1000).nullable().optional(),
});

router.post(
  "/transcripts/:id/relations",
  async (req: Request, res: Response): Promise<void> => {
    const id = uuidParam(req, res, "id");
    if (!id) return;
    const parsed = CreateRelationBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }
    if (parsed.data.to_id === id) {
      res.status(400).json({ error: "A transcript cannot relate to itself" });
      return;
    }
    try {
      const from = await getTranscriptOr404(id, res);
      if (!from) return;

      const target = await db
        .select({ id: transcriptsTable.id })
        .from(transcriptsTable)
        .where(eq(transcriptsTable.id, parsed.data.to_id))
        .limit(1);
      if (!target.length) {
        res.status(404).json({ error: "Target transcript not found" });
        return;
      }

      // Reject duplicates: same (from,to,kind) OR same (to,from,kind) so a
      // pair isn't double-linked in opposite directions.
      const dupes = await db
        .select({ id: transcriptRelationsTable.id })
        .from(transcriptRelationsTable)
        .where(
          and(
            eq(transcriptRelationsTable.kind, parsed.data.kind),
            or(
              and(
                eq(transcriptRelationsTable.fromId, from.id),
                eq(transcriptRelationsTable.toId, parsed.data.to_id),
              ),
              and(
                eq(transcriptRelationsTable.fromId, parsed.data.to_id),
                eq(transcriptRelationsTable.toId, from.id),
              ),
            ),
          ),
        )
        .limit(1);
      if (dupes.length) {
        res
          .status(409)
          .json({ error: "These transcripts are already linked with that relation" });
        return;
      }

      const inserted = await db
        .insert(transcriptRelationsTable)
        .values({
          fromId: from.id,
          toId: parsed.data.to_id,
          kind: parsed.data.kind,
          note: parsed.data.note ?? null,
        })
        .returning();
      res.json({ relation: inserted[0] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  },
);

router.delete(
  "/relations/:relId",
  async (req: Request, res: Response): Promise<void> => {
    const relId = uuidParam(req, res, "relId");
    if (!relId) return;
    try {
      await db
        .delete(transcriptRelationsTable)
        .where(eq(transcriptRelationsTable.id, relId));
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  },
);

// ─── AI CHAT (SSE) ───────────────────────────────────────────────────────────

const ChatBody = z.object({
  question: z.string().trim().min(1).max(2000),
  include_related: z.boolean().optional().default(true),
});

const MAX_RELATED_FOR_CHAT = 4;

router.post(
  "/transcripts/:id/chat",
  async (req: Request, res: Response): Promise<void> => {
    const id = uuidParam(req, res, "id");
    if (!id) return;
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }
    const t = await getTranscriptOr404(id, res);
    if (!t) return;

    // Gather related transcripts (capped) when requested
    let related: Array<{ title: string; kind: RelationKind; text: string }> = [];
    if (parsed.data.include_related) {
      const rels = await db
        .select()
        .from(transcriptRelationsTable)
        .where(
          or(
            eq(transcriptRelationsTable.fromId, t.id),
            eq(transcriptRelationsTable.toId, t.id),
          ),
        );
      const otherIds = Array.from(
        new Set(rels.flatMap((r) => [r.fromId, r.toId]).filter((id) => id !== t.id)),
      );
      if (otherIds.length) {
        const others = await db
          .select({
            id: transcriptsTable.id,
            title: transcriptsTable.title,
            text: transcriptsTable.text,
          })
          .from(transcriptsTable)
          .where(inArray(transcriptsTable.id, otherIds));
        const otherMap = new Map(others.map((o) => [o.id, o]));
        related = rels
          .map((r) => {
            const otherId = r.fromId === t.id ? r.toId : r.fromId;
            const other = otherMap.get(otherId);
            if (!other) return null;
            return {
              title: other.title,
              kind: r.kind as RelationKind,
              text: other.text,
            };
          })
          .filter(
            (x): x is { title: string; kind: RelationKind; text: string } =>
              x !== null,
          )
          .slice(0, MAX_RELATED_FOR_CHAT);
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const systemPrompt = `You are an assistant helping the user understand their saved audio transcripts.
Answer based ONLY on the transcripts provided as context. Be concise, accurate, and quote when useful.
If a transcript was truncated, work with what is shown and note the limitation if relevant.
If the answer is not in the transcripts, say so plainly.`;

    const primary = truncateForAI(t.text, AI_MAX_PRIMARY_CHARS);
    const contextParts: string[] = [
      `=== PRIMARY TRANSCRIPT: "${t.title}" ===\n${primary.text}`,
    ];
    related.forEach((r, i) => {
      const trimmed = truncateForAI(r.text, AI_MAX_RELATED_CHARS);
      contextParts.push(
        `=== RELATED TRANSCRIPT #${i + 1} (relation: ${r.kind}): "${r.title}" ===\n${trimmed.text}`,
      );
    });

    const userPrompt = `${contextParts.join("\n\n")}\n\n=== USER QUESTION ===\n${parsed.data.question}`;

    try {
      send("meta", { related_count: related.length });
      await groqStream(
        {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 1200,
        },
        (token) => send("token", { token }),
      );
      send("done", {});
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err: msg }, "Chat failed");
      send("error", { error: msg });
      res.end();
    }
  },
);

export default router;
