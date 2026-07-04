import { expect, test } from "bun:test";
import { getTestDb } from "./get-test-db";
import { documents, memories, memoryDocumentSources } from "../src/schema";
import { eq } from "drizzle-orm";

test("verify documents, memories, and provenance with cascades", async () => {
  const db = getTestDb();

  console.log("   --- Starting Schema Cascade Test ---");

  // 1. Clear database
  console.log("   [1/7] Clearing table entries from previous runs...");
  await db.delete(memoryDocumentSources);
  await db.delete(memories);
  await db.delete(documents);

  // 2. Insert Document
  console.log("   [2/7] Inserting test document...");
  const docId = `doc_${Date.now()}`;
  const newDoc = {
    id: docId,
    userId: "user_1",
    containerTag: "space_a",
    title: "Test Document",
    content: "This is test content containing fact: Alex is a PM at Acme.",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(documents).values(newDoc);

  // 3. Insert Memory
  console.log("   [3/7] Inserting test memory fact...");
  const memId = `mem_${Date.now()}`;
  const newMem = {
    id: memId,
    memory: "Alex is a PM at Acme",
    userId: "user_1",
    containerTag: "space_a",
    version: 1,
    isLatest: true,
    memoryRelations: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(memories).values(newMem);

  // 4. Link Memory and Document (Provenance)
  console.log("   [4/7] Linking memory fact to document source...");
  await db.insert(memoryDocumentSources).values({
    memoryEntryId: memId,
    documentId: docId,
    addedAt: new Date(),
  });

  // 5. Query and verify relationships
  console.log("   [5/7] Verifying initial database relations...");
  const [docResult] = await db.select().from(documents).where(eq(documents.id, docId));
  expect(docResult).toBeDefined();
  expect(docResult?.title).toBe("Test Document");

  const [memResult] = await db.select().from(memories).where(eq(memories.id, memId));
  expect(memResult).toBeDefined();
  expect(memResult?.memory).toBe("Alex is a PM at Acme");

  const [linkResult] = await db
    .select()
    .from(memoryDocumentSources)
    .where(eq(memoryDocumentSources.memoryEntryId, memId));
  expect(linkResult).toBeDefined();
  expect(linkResult?.documentId).toBe(docId);

  // 5b. Insert and verify derived memory relations
  console.log("   [5b] Inserting a derived memory fact and verifying inline JSON graph relations...");
  const derivedMemId = `mem_derived_${Date.now()}`;
  const derivedMem = {
    id: derivedMemId,
    memory: "Alex works at Acme PM division",
    userId: "user_1",
    containerTag: "space_a",
    version: 1,
    isLatest: true,
    memoryRelations: { [memId]: "derives" as const },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(memories).values(derivedMem);

  const [derivedResult] = await db.select().from(memories).where(eq(memories.id, derivedMemId));
  expect(derivedResult).toBeDefined();
  expect(derivedResult?.memoryRelations).toEqual({ [memId]: "derives" });

  // 6. Test Cascade Delete: Delete Document, check link deletion
  console.log("   [6/7] Deleting document and testing cascade on link table...");
  await db.delete(documents).where(eq(documents.id, docId));
  const linkAfterDocDelete = await db
    .select()
    .from(memoryDocumentSources)
    .where(eq(memoryDocumentSources.documentId, docId));
  expect(linkAfterDocDelete.length).toBe(0);

  // Re-insert document and link to test memory cascade delete
  console.log("   [7/7] Re-inserting document and testing cascade on memory deletion...");
  await db.insert(documents).values(newDoc);
  await db.insert(memoryDocumentSources).values({
    memoryEntryId: memId,
    documentId: docId,
    addedAt: new Date(),
  });

  // Delete Memory, check link deletion
  // NOTE: Stale references inside other memories' inline JSON 'memoryRelations' (e.g., derivedMem)
  // are NOT cleaned up by database cascades. They must be cleaned up programmatically 
  // in the memory deletion/cleanup pipeline.
  await db.delete(memories).where(eq(memories.id, memId));
  const linkAfterMemDelete = await db
    .select()
    .from(memoryDocumentSources)
    .where(eq(memoryDocumentSources.memoryEntryId, memId));
  expect(linkAfterMemDelete.length).toBe(0);

  console.log("   --- Schema Cascade Test: SUCCESS ---");
});
