import { and, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { memories, memoryDocumentSources, documents, users } from "./schema";
import * as schema from "./schema";

// Restrict to "async" only: ingestFactTransaction uses async callbacks inside
// db.transaction(); a sync driver can complete the transaction before awaited
// statements inside it finish, silently breaking atomicity guarantees.
type AnyDb = BaseSQLiteDatabase<"async", unknown, typeof schema>;

export interface IngestFactRelation {
  type: "updates" | "extends" | "derives";
  targetId: string;
}

export interface IngestFact {
  memoryText: string;
  containerTag: string;
  userId: string;
  documentId: string; // Provenance document ID
  relations: IngestFactRelation[];
  isStatic?: boolean;
  forgetAfter?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Perform atomic ingestion transaction:
 * 1. Checks relations for 'updates'. If so, updates target memory's isLatest to false.
 * 2. Inserts new memory with incremented version and parent/root pointers, and sets memoryRelations JSON.
 * 3. Records memory provenance in memoryDocumentSources.
 */
export async function ingestFactTransaction(db: AnyDb, fact: IngestFact): Promise<string> {
  const newId = `mem_${crypto.randomUUID()}`;
  const now = new Date();

  // Resolve relation types from the incoming relations array
  const updateRel = fact.relations.find((r) => r.type === "updates");

  // Build the memoryRelations JSON map (exclude "updates" since it is tracked via SQL columns)
  const memRelations: Record<string, "extends" | "derives"> = {};
  for (const rel of fact.relations) {
    if (rel.type !== "updates") {
      memRelations[rel.targetId] = rel.type;
    }
  }

  return await db.transaction(async (tx) => {
    let version = 1;
    let parentMemoryId: string | null = null;
    let rootMemoryId: string | null = null;

    if (updateRel) {
      // 1. Process Update: fetch target memory
      const [target] = await tx
        .select()
        .from(memories)
        .where(eq(memories.id, updateRel.targetId));

      if (!target) {
        throw new Error(`Target memory with ID ${updateRel.targetId} not found`);
      }

      // Atomically flip isLatest = false only if the row is still the latest.
      // Using .where(isLatest = true) + .returning() makes this a single atomic
      // compare-and-swap: if two concurrent transactions race, only one will
      // match the predicate and get a returned row; the other gets undefined
      // and throws, preventing competing version branches.
      const [updatedTarget] = await tx
        .update(memories)
        .set({ isLatest: false, updatedAt: now })
        .where(and(eq(memories.id, target.id), eq(memories.isLatest, true)))
        .returning({ id: memories.id });

      if (!updatedTarget) {
        throw new Error(`Target memory with ID ${updateRel.targetId} is no longer the latest version`);
      }

      version = target.version + 1;
      parentMemoryId = target.id;
      rootMemoryId = target.rootMemoryId || target.id;
    }

    // 2. Insert the new memory (either standalone or updated version)
    await tx.insert(memories).values({
      id: newId,
      memory: fact.memoryText,
      containerTag: fact.containerTag,
      userId: fact.userId,
      version,
      isLatest: true,
      parentMemoryId,
      rootMemoryId,
      memoryRelations: memRelations,
      sourceCount: 1,
      isForgotten: false,
      isStatic: fact.isStatic ?? false,
      forgetAfter: fact.forgetAfter ?? null,
      createdAt: now,
      updatedAt: now,
      metadata: fact.metadata ?? null,
    });

    // 3. Record provenance link
    await tx.insert(memoryDocumentSources).values({
      memoryEntryId: newId,
      documentId: fact.documentId,
      addedAt: now,
    });

    return newId;
  });
}

/**
 * Helper to insert a raw document.
 */
export async function insertDocument(db: AnyDb, document: typeof documents.$inferInsert) {
  const [result] = await db.insert(documents).values(document).returning();
  return result;
}

/**
 * Helper to insert a user.
 */
export async function insertUser(db: AnyDb, user: typeof users.$inferInsert) {
  const [result] = await db.insert(users).values(user).returning();
  return result;
}

/**
 * Helper to retrieve a document by ID.
 */
export async function getDocumentById(db: AnyDb, id: string) {
  const [result] = await db.select().from(documents).where(eq(documents.id, id));
  return result ?? null;
}

/**
 * Helper to retrieve a memory by ID.
 */
export async function getMemoryById(db: AnyDb, id: string) {
  const [result] = await db.select().from(memories).where(eq(memories.id, id));
  return result ?? null;
}
