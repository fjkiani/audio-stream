import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { transcriptsTable } from "./transcripts";

export const RELATION_KINDS = [
  "related",
  "follow_up",
  "continues",
  "elaborates",
  "contradicts",
  "references",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export const transcriptRelationsTable = pgTable(
  "transcript_relations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromId: uuid("from_id")
      .notNull()
      .references(() => transcriptsTable.id, { onDelete: "cascade" }),
    toId: uuid("to_id")
      .notNull()
      .references(() => transcriptsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("related"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fromIdx: index("transcript_relations_from_idx").on(t.fromId),
    toIdx: index("transcript_relations_to_idx").on(t.toId),
  })
);

export const insertTranscriptRelationSchema = createInsertSchema(
  transcriptRelationsTable
).omit({ id: true, createdAt: true });

export type TranscriptRelation = typeof transcriptRelationsTable.$inferSelect;
export type InsertTranscriptRelation = z.infer<typeof insertTranscriptRelationSchema>;
