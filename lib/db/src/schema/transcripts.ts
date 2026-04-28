import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const transcriptsTable = pgTable("transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  text: text("text").notNull(),
  originalFilename: text("original_filename").notNull(),
  audioDuration: real("audio_duration"),
  languageCode: text("language_code"),
  wordCount: integer("word_count").notNull().default(0),
  summary: text("summary"),
  bullets: jsonb("bullets").$type<string[]>(),
  assemblyaiId: text("assemblyai_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTranscriptSchema = createInsertSchema(transcriptsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Transcript = typeof transcriptsTable.$inferSelect;
export type InsertTranscript = z.infer<typeof insertTranscriptSchema>;
