import { and, eq, sql, desc } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { memories, memoryDocumentSources, documents, users } from "./schema";
import * as schema from "./schema";

export type AnyDb = BaseSQLiteDatabase<"async", unknown, typeof schema> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  batch?: (queries: any) => Promise<any>;
};

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

  const updateRel = fact.relations.find((r) => r.type === "updates");

  const memRelations: Record<string, "extends" | "derives"> = {};
  for (const rel of fact.relations) {
    if (rel.type !== "updates") {
      memRelations[rel.targetId] = rel.type;
    }
  }

  if (updateRel) {
    const parentId = updateRel.targetId;

    // First, verify the target exists and is currently the latest version.
    const [target] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, parentId));

    if (!target) {
      throw new Error(`Target memory with ID ${parentId} not found`);
    }
    if (!target.isLatest) {
      throw new Error(`Target memory with ID ${parentId} is no longer the latest version`);
    }

    if (typeof db.batch === "function") {
      // ── Cloudflare D1 Production Path: Atomic D1 batch query ────────────────
      await db.batch([
        db.update(memories)
          .set({ isLatest: false, updatedAt: now })
          .where(and(eq(memories.id, parentId), eq(memories.isLatest, true))),
        db.insert(memories).values({
          id: newId,
          memory: fact.memoryText,
          containerTag: fact.containerTag,
          userId: fact.userId,
          version: sql`(SELECT version + 1 FROM memories WHERE id = ${parentId})`,
          isLatest: true,
          parentMemoryId: parentId,
          rootMemoryId: sql`COALESCE((SELECT root_memory_id FROM memories WHERE id = ${parentId}), ${parentId})`,
          memoryRelations: memRelations,
          sourceCount: 1,
          isForgotten: false,
          isStatic: fact.isStatic ?? false,
          forgetAfter: fact.forgetAfter ?? null,
          createdAt: now,
          updatedAt: now,
          metadata: fact.metadata ?? null,
        }),
        db.insert(memoryDocumentSources).values({
          memoryEntryId: newId,
          documentId: fact.documentId,
          addedAt: now,
        }),
      ]);
    } else {
      // ── Local testing fallback path: Transaction block ─────────────────────
      await db.transaction(async (tx) => {
        await tx.update(memories)
          .set({ isLatest: false, updatedAt: now })
          .where(and(eq(memories.id, parentId), eq(memories.isLatest, true)));
        await tx.insert(memories).values({
          id: newId,
          memory: fact.memoryText,
          containerTag: fact.containerTag,
          userId: fact.userId,
          version: target.version + 1,
          isLatest: true,
          parentMemoryId: parentId,
          rootMemoryId: target.rootMemoryId || target.id,
          memoryRelations: memRelations,
          sourceCount: 1,
          isForgotten: false,
          isStatic: fact.isStatic ?? false,
          forgetAfter: fact.forgetAfter ?? null,
          createdAt: now,
          updatedAt: now,
          metadata: fact.metadata ?? null,
        });
        await tx.insert(memoryDocumentSources).values({
          memoryEntryId: newId,
          documentId: fact.documentId,
          addedAt: now,
        });
      });
    }

  } else {
    // ── Brand New Standalone Fact Batch ──────────────────────────────────────
    if (typeof db.batch === "function") {
      await db.batch([
        db.insert(memories).values({
          id: newId,
          memory: fact.memoryText,
          containerTag: fact.containerTag,
          userId: fact.userId,
          version: 1,
          isLatest: true,
          parentMemoryId: null,
          rootMemoryId: null,
          memoryRelations: memRelations,
          sourceCount: 1,
          isForgotten: false,
          isStatic: fact.isStatic ?? false,
          forgetAfter: fact.forgetAfter ?? null,
          createdAt: now,
          updatedAt: now,
          metadata: fact.metadata ?? null,
        }),
        db.insert(memoryDocumentSources).values({
          memoryEntryId: newId,
          documentId: fact.documentId,
          addedAt: now,
        }),
      ]);
    } else {
      await db.transaction(async (tx) => {
        await tx.insert(memories).values({
          id: newId,
          memory: fact.memoryText,
          containerTag: fact.containerTag,
          userId: fact.userId,
          version: 1,
          isLatest: true,
          parentMemoryId: null,
          rootMemoryId: null,
          memoryRelations: memRelations,
          sourceCount: 1,
          isForgotten: false,
          isStatic: fact.isStatic ?? false,
          forgetAfter: fact.forgetAfter ?? null,
          createdAt: now,
          updatedAt: now,
          metadata: fact.metadata ?? null,
        });
        await tx.insert(memoryDocumentSources).values({
          memoryEntryId: newId,
          documentId: fact.documentId,
          addedAt: now,
        });
      });
    }
  }

  return newId;
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

export interface GraphMemory {
  id: string;
  memory: string;
  isStatic: boolean;
  depth: number;
}

/**
 * Traverses memoryRelations graph bidirectionally up to maxDepth hops starting from seed IDs.
 */
export async function getRelatedMemories(
  db: AnyDb,
  seeds: string[],
  userId: string,
  containerTag: string,
  maxDepth = 2
): Promise<GraphMemory[]> {
  if (seeds.length === 0) return [];

  // Validate seed IDs to prevent SQL injection issues when interpolating in CTE raw SQL
  const validatedSeeds = seeds.filter((s) => typeof s === "string" && s.startsWith("mem_"));
  if (validatedSeeds.length === 0) return [];

  const seedChunks = validatedSeeds.map((s) => sql`${s}`);
  const seedsListSql = sql.join(seedChunks, sql.raw(", "));

  const query = sql`
    WITH RECURSIVE 
    edges(source, target) AS (
      SELECT m.id, j.key
      FROM memories m, json_each(m.memory_relations) j
      WHERE m.user_id = ${userId} 
        AND m.container_tag = ${containerTag}
        AND m.is_latest = 1 
        AND m.is_forgotten = 0
    ),
    graph_cte(id, depth) AS (
      SELECT id, 0 AS depth
      FROM memories
      WHERE id IN (${seedsListSql}) 
        AND user_id = ${userId} 
        AND container_tag = ${containerTag}
        AND is_latest = 1 
        AND is_forgotten = 0
      
      UNION
      
      SELECT e.target AS id, c.depth + 1 AS depth
      FROM graph_cte c
      JOIN edges e ON e.source = c.id
      WHERE c.depth < ${maxDepth}
      
      UNION
      
      SELECT e.source AS id, c.depth + 1 AS depth
      FROM graph_cte c
      JOIN edges e ON e.target = c.id
      WHERE c.depth < ${maxDepth}
    )
    SELECT g.id, m.memory, m.is_static, MIN(g.depth) AS depth
    FROM graph_cte g
    JOIN memories m ON m.id = g.id
    WHERE m.user_id = ${userId}
      AND m.container_tag = ${containerTag}
      AND m.is_latest = 1 
      AND m.is_forgotten = 0
    GROUP BY g.id
    ORDER BY depth ASC;
  `;

  const rows = await db.all<{ id: string; memory: string; is_static: number; depth: number }>(query);
  return rows.map((r) => ({
    id: r.id,
    memory: r.memory,
    isStatic: r.is_static === 1,
    depth: r.depth,
  }));
}

/**
 * Retrieves the static profile facts and recent dynamic memory entries for a user profile context.
 */
export async function getProfileMemories(
  db: AnyDb,
  userId: string,
  containerTag: string
): Promise<schema.Memory[]> {
  const [staticMemories, dynamicMemories] = await Promise.all([
    db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.containerTag, containerTag),
          eq(memories.isStatic, true),
          eq(memories.isLatest, true),
          eq(memories.isForgotten, false)
        )
      )
      .limit(20),
    db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.containerTag, containerTag),
          eq(memories.isStatic, false),
          eq(memories.isLatest, true),
          eq(memories.isForgotten, false)
        )
      )
      .orderBy(desc(memories.createdAt))
      .limit(5)
  ]);

  const allMemoriesMap = new Map<string, schema.Memory>();
  for (const m of [...staticMemories, ...dynamicMemories]) {
    allMemoriesMap.set(m.id, m);
  }
  return Array.from(allMemoriesMap.values());
}

