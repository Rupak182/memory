import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// Original Document metadata
export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  customId: text("custom_id"), // Custom identifier (e.g. file paths /memories/config.txt)
  contentHash: text("content_hash"), // Deduping raw content
  userId: text("user_id").notNull(), // Owner/Author of this document
  containerTag: text("container_tag").notNull(), // Grouping tag (e.g., project_id or user_id)
  title: text("title"),
  content: text("content"),
  summary: text("summary"),
  url: text("url"),
  source: text("source"), // E.g., telegram, twitter, api, mcp, extension
  type: text("type").default("text").notNull(), // text, pdf, tweet, image, webpage, etc.
  status: text("status").default("unknown").notNull(), // queued, chunking, done, failed
  tokenCount: integer("token_count"),
  wordCount: integer("word_count"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(), // JSON-serialized metadata object (source, pages, authors)
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("doc_user_container_idx").on(table.userId, table.containerTag),
  index("doc_custom_id_idx").on(table.customId),
]);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

// Atomic Fact Entries (Nodes)
export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  memory: text("memory").notNull(), // The atomic fact string
  userId: text("user_id").notNull(), // Owner/Author who generated this fact
  containerTag: text("container_tag").notNull(), // Grouping tag matching documents
  
  // Versioning state machine columns
  version: integer("version").default(1).notNull(),
  isLatest: integer("is_latest", { mode: "boolean" }).default(true).notNull(),
  parentMemoryId: text("parent_memory_id"),
  rootMemoryId: text("root_memory_id"),
  
  // Memory relationships (stored inline as a JSON Record<targetId, relationType>)
  // NOTE: Stale references inside this JSON object are not automatically cleaned up 
  // by database cascades when the target memory is deleted. Programmatic cleanup is required.
  memoryRelations: text("memory_relations", { mode: "json" })
    .$type<Record<string, "updates" | "extends" | "derives">>()
    .default({})
    .notNull(),

  sourceCount: integer("source_count").default(1).notNull(),
  isForgotten: integer("is_forgotten", { mode: "boolean" }).default(false).notNull(),
  isStatic: integer("is_static", { mode: "boolean" }).default(false).notNull(), // Non-temporal profile facts
  forgetAfter: integer("forget_after", { mode: "timestamp" }),
  forgetReason: text("forget_reason"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(), // JSON-serialized metadata (confidence, tags, overrides)
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("mem_latest_search_idx").on(table.containerTag, table.isLatest, table.isForgotten),
  uniqueIndex("mem_parent_unique_idx").on(table.parentMemoryId),
  index("mem_root_idx").on(table.rootMemoryId),
]);

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

// Ingestion provenance tracking
export const memoryDocumentSources = sqliteTable("memory_document_sources", {
  memoryEntryId: text("memory_entry_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  addedAt: integer("added_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.memoryEntryId, table.documentId] }),
]);

export type MemoryDocumentSource = typeof memoryDocumentSources.$inferSelect;
export type NewMemoryDocumentSource = typeof memoryDocumentSources.$inferInsert;

