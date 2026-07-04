import { expect, test } from "bun:test";
import { getTestDb } from "./get-test-db";
import { documents, memories, memoryDocumentSources } from "../src/schema";
import { ingestFactTransaction } from "../src/queries";
import { eq } from "drizzle-orm";

test("verify ingestFactTransaction state machine logic", async () => {
  const db = getTestDb();

  console.log("   --- Starting Ingestion State Machine Unit Test ---");

  // 1. Clear database
  await db.delete(memoryDocumentSources);
  await db.delete(memories);
  await db.delete(documents);

  // Pre-insert a document for testing
  const docId = "doc_timeline_source";
  await db.insert(documents).values({
    id: docId,
    userId: "user_test",
    containerTag: "space_test",
    title: "Timeline source document",
    content: "Timeline facts source.",
  });

  // Timeline Step 1: Ingest: "User prefers React for web development" (mem_1)
  console.log("   [Step 1] Ingesting initial fact: 'User prefers React'...");
  const mem1Id = await ingestFactTransaction(db, {
    memoryText: "User prefers React for web development",
    containerTag: "space_test",
    userId: "user_test",
    documentId: docId,
    relations: [],
  });

  // Timeline Step 2: Ingest: "User lives in Boston" (mem_2)
  console.log("   [Step 2] Ingesting standalone fact: 'User lives in Boston'...");
  const mem2Id = await ingestFactTransaction(db, {
    memoryText: "User lives in Boston",
    containerTag: "space_test",
    userId: "user_test",
    documentId: docId,
    relations: [],
  });

  // Timeline Step 3: Ingest: "User switched to Next.js" (mem_3, updates mem_1)
  console.log("   [Step 3] Ingesting update fact: 'User switched to Next.js' (updates mem_1)...");
  const mem3Id = await ingestFactTransaction(db, {
    memoryText: "User switched to Next.js",
    containerTag: "space_test",
    userId: "user_test",
    documentId: docId,
    relations: [{ type: "updates", targetId: mem1Id }],
  });

  // Timeline Step 4: Ingest: "User lives in Back Bay, Boston" (mem_4, extends mem_2)
  console.log("   [Step 4] Ingesting extension fact: 'User lives in Back Bay, Boston' (extends mem_2)...");
  const mem4Id = await ingestFactTransaction(db, {
    memoryText: "User lives in Back Bay, Boston",
    containerTag: "space_test",
    userId: "user_test",
    documentId: docId,
    relations: [{ type: "extends", targetId: mem2Id }],
  });

  // --- Verifications ---
  console.log("   [Verification] Asserting correctness of state machine properties...");

  // check mem_1 (obsoleted)
  const [mem1] = await db.select().from(memories).where(eq(memories.id, mem1Id));
  expect(mem1).toBeDefined();
  expect(mem1?.isLatest).toBe(false);
  expect(mem1?.version).toBe(1);

  // check mem_2 (still latest, extended)
  const [mem2] = await db.select().from(memories).where(eq(memories.id, mem2Id));
  expect(mem2).toBeDefined();
  expect(mem2?.isLatest).toBe(true);
  expect(mem2?.version).toBe(1);

  // check mem_3 (updated version of mem_1)
  const [mem3] = await db.select().from(memories).where(eq(memories.id, mem3Id));
  expect(mem3).toBeDefined();
  expect(mem3?.isLatest).toBe(true);
  expect(mem3?.version).toBe(2);
  expect(mem3?.parentMemoryId).toBe(mem1Id);
  expect(mem3?.rootMemoryId).toBe(mem1Id);

  // check mem_4 (extension of mem_2)
  const [mem4] = await db.select().from(memories).where(eq(memories.id, mem4Id));
  expect(mem4).toBeDefined();
  expect(mem4?.isLatest).toBe(true);
  expect(mem4?.version).toBe(1);
  expect(mem4?.memoryRelations).toEqual({ [mem2Id]: "extends" });

  // verify provenance links
  const links = await db.select().from(memoryDocumentSources);
  expect(links.length).toBe(4);

  // verify that updating an already obsoleted memory throws an error
  console.log("   [Step 5] Verifying that updating an obsolete version fails...");
  await expect(
    ingestFactTransaction(db, {
      memoryText: "User wants to use Vue instead of React",
      containerTag: "space_test",
      userId: "user_test",
      documentId: docId,
      relations: [{ type: "updates", targetId: mem1Id }],
    })
  ).rejects.toThrow("is no longer the latest version");

  console.log("   --- Ingestion State Machine Unit Test: SUCCESS ---");
});
