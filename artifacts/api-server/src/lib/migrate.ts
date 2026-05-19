import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Run idempotent schema migrations at startup.
 * Uses raw SQL with IF NOT EXISTS so it's safe to run on every boot.
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    logger.info("Running startup migrations...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        audio_duration REAL,
        language_code TEXT,
        word_count INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        bullets JSONB,
        assemblyai_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transcript_relations (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        from_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
        to_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'related',
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS transcript_relations_from_idx
        ON transcript_relations(from_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS transcript_relations_to_idx
        ON transcript_relations(to_id)
    `);

    logger.info("Migrations complete.");
  } finally {
    client.release();
  }
}
