import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { db, transcriptsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const ASSEMBLY_BASE = "https://api.assemblyai.com/v2";

async function pollTranscript(
  id: string,
  apiKey: string,
  onPoll?: (status: string) => void
): Promise<{
  text: string;
  audio_duration: number | null;
  language_code: string | null;
  words: Array<{ text: string; start: number; end: number; confidence: number }>;
}> {
  const start = Date.now();
  const timeoutMs = 10 * 60 * 1000;

  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${ASSEMBLY_BASE}/transcript/${id}`, {
      headers: { Authorization: apiKey },
    });
    if (!r.ok) {
      throw new Error(`Poll failed: ${r.status} ${await r.text()}`);
    }
    const data = (await r.json()) as {
      status: "queued" | "processing" | "completed" | "error";
      text?: string;
      error?: string;
      audio_duration?: number;
      language_code?: string;
      words?: Array<{ text: string; start: number; end: number; confidence: number }>;
    };

    if (onPoll) onPoll(data.status);

    if (data.status === "completed") {
      return {
        text: data.text ?? "",
        audio_duration: data.audio_duration ?? null,
        language_code: data.language_code ?? null,
        words: data.words ?? [],
      };
    }
    if (data.status === "error") {
      throw new Error(data.error ?? "Transcription failed");
    }

    await new Promise((res) => setTimeout(res, 2000));
  }

  throw new Error("Transcription timed out after 10 minutes");
}

router.post(
  "/transcribe",
  upload.single("audio"),
  async (req: Request, res: Response): Promise<void> => {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "ASSEMBLYAI_API_KEY not configured" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No audio file uploaded (field name: 'audio')" });
      return;
    }

    const file = req.file;
    logger.info(
      { name: file.originalname, size: file.size, mimetype: file.mimetype },
      "Received audio for transcription"
    );

    try {
      const uploadResp = await fetch(`${ASSEMBLY_BASE}/upload`, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/octet-stream",
        },
        body: file.buffer,
      });

      if (!uploadResp.ok) {
        const text = await uploadResp.text();
        res.status(502).json({ error: `Upload to AssemblyAI failed: ${text}` });
        return;
      }

      const { upload_url } = (await uploadResp.json()) as { upload_url: string };
      logger.info({ upload_url }, "Audio uploaded to AssemblyAI");

      const speakerLabels = req.body.speaker_labels === "true" || req.body.speaker_labels === true;
      const punctuate = req.body.punctuate !== "false" && req.body.punctuate !== false;
      const formatText = req.body.format_text !== "false" && req.body.format_text !== false;

      const createResp = await fetch(`${ASSEMBLY_BASE}/transcript`, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url: upload_url,
          speech_models: ["universal-2"],
          speaker_labels: speakerLabels,
          punctuate,
          format_text: formatText,
        }),
      });

      if (!createResp.ok) {
        const text = await createResp.text();
        res.status(502).json({ error: `Create transcript failed: ${text}` });
        return;
      }

      const { id } = (await createResp.json()) as { id: string };
      logger.info({ id }, "Transcript job created");

      const result = await pollTranscript(id, apiKey, (status) => {
        logger.info({ id, status }, "Transcript polling");
      });

      // Persist to DB. Auto-derive a friendly title from the filename.
      const title = (file.originalname.replace(/\.[^.]+$/, "") || "Untitled").slice(0, 280);
      const inserted = await db
        .insert(transcriptsTable)
        .values({
          title,
          text: result.text,
          originalFilename: file.originalname,
          audioDuration: result.audio_duration ?? null,
          languageCode: result.language_code ?? null,
          wordCount: result.words.length,
          assemblyaiId: id,
        })
        .returning();

      const saved = inserted[0];

      res.json({
        id: saved.id,
        assemblyai_id: id,
        title: saved.title,
        text: saved.text,
        audio_duration: saved.audioDuration,
        language_code: saved.languageCode,
        word_count: saved.wordCount,
        original_filename: saved.originalFilename,
        original_size: file.size,
        created_at: saved.createdAt.toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err: msg }, "Transcription failed");
      res.status(500).json({ error: msg });
    }
  }
);

export default router;
