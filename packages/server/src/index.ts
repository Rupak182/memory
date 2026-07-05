import { Hono } from "hono";
import {
  getDb, users, documents, memories,
  getEmbedding, getEmbeddings, queryVector,
  insertDocument, ingestFactTransaction, upsertVector, deleteVector,
  eq, and,
} from "@memory/database";
import { SHARED_VERSION } from "@memory/shared";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { extractFacts } from "./extractor";
import { splitText } from "./splitter";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/", (c) => {
  return c.text(`Hello Hono! Shared Version: ${SHARED_VERSION}`);
});

app.get("/db-test", async (c) => {
  try {
    const db = getDb(c.env.DB);
    const allUsers = await db.select({ id: users.id }).from(users).limit(10);
    return c.json({ status: "success", version: SHARED_VERSION, users: allUsers });
  } catch (error) {
    const err = error as Error;
    console.error("Failed to query database:", err);
    return c.json({ status: "error", message: "Failed to query database" }, 500);
  }
});

app.get("/test-vectorize", async (c) => {
  const ids: string[] = ["vec_k8s", "vec_nextjs", "vec_boston"];
  const index = c.env.CHUNKS_INDEX;

  try {
    const ai = c.env.AI;

    console.log("   [Step 1] Generating embeddings for three distinct topics...");
    const texts: string[] = [
      "Kubernetes is an open-source container orchestration system.",
      "Next.js is a React framework for building full-stack web applications.",
      "Boston is the capital and most populous city of Massachusetts."
    ];
    
    const embeddings = await getEmbeddings(ai, texts);
    const vectors = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const id = ids[i];
      const embedding = embeddings[i];
      if (!text || !id || !embedding) continue;
      
      vectors.push({
        id,
        values: embedding,
        metadata: { text }
      });
    }

    console.log("   [Step 2] Upserting vectors into CHUNKS_INDEX...");
    await index.upsert(vectors);

    console.log("   Waiting 12 seconds for Vectorize to index the vectors...");
    await new Promise((resolve) => setTimeout(resolve, 12000));

    console.log("   [Step 3] Querying the index with 'What is Kubernetes?'...");
    const queryEmbed = await getEmbedding(ai, "What is Kubernetes?");
    const matches = await queryVector(index, queryEmbed, 3);

    console.log("   [Step 4] Checking match relevance...");
    const bestMatch = matches[0];
    if (!bestMatch) {
      throw new Error("No matches returned from index");
    }

    console.log(`   Best match ID: ${bestMatch.id} (Score: ${bestMatch.score})`);

    if (bestMatch.id !== "vec_k8s") {
      throw new Error(`Expected vec_k8s to be the best match, but got ${bestMatch.id}`);
    }

    console.log("   Verification checks for Phase 3: SUCCESS ✅");
    return c.json({ status: "success", message: "Phase 3 verification passed!" });
  } catch (error) {
    const err = error as Error;
    console.error("Verification failed:", err);
    return c.json({ status: "error", message: "Verification failed" }, 500);
  } finally {
    console.log("   [Step 5] Cleaning up generated test vectors...");
    await index.deleteByIds(ids).catch((e) => {
      console.error("Cleanup failed:", e);
    });
  }
});

const TestExtractorRequestSchema = z.object({
  text: z.string().min(1, "text field is required in request body"),
  candidates: z.array(
    z.object({
      id: z.string(),
      memory: z.string(),
    })
  ).optional(),
});

app.post(
  "/test-extractor",
  zValidator("json", TestExtractorRequestSchema),
  async (c) => {
    try {
      const ai = c.env.AI;
      const body = c.req.valid("json");

      console.log("   [Step 1] Running fact extractor LLM...");
      const result = await extractFacts(ai, body.text, body.candidates || []);

      return c.json({ status: "success", result });
    } catch (error) {
      const err = error as Error;
      console.error("Extraction verification failed:", err);
      return c.json({ status: "error", message: "Extraction failed" }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Document Ingestion Pipeline
// ─────────────────────────────────────────────────────────────────────────────

const IngestDocumentSchema = z.object({
  content:      z.string().min(1, "content is required"),
  userId:       z.string().min(1, "userId is required"),
  containerTag: z.string().min(1, "containerTag is required"),
  // Optional document metadata
  customId:  z.string().optional(),
  title:     z.string().optional(),
  url:       z.string().optional(),
  source:    z.string().optional(),
  type:      z.string().optional(),
  metadata:  z.record(z.string(), z.unknown()).optional(),
});

app.post(
  "/v3/documents",
  zValidator("json", IngestDocumentSchema),
  async (c) => {
    const body = c.req.valid("json");
    const { AI, DB, MEMORIES_INDEX } = c.env;
    const db = getDb(DB);
    let docId: string | null = null;

    try {
      // 1. Persist the source document ───────────────────────────────────────
      console.log("[/v3/documents] Step 1: inserting document into D1...");
      docId = `doc_${crypto.randomUUID()}`;
      await insertDocument(db, {
        id:           docId,
        customId:     body.customId ?? null,
        contentHash:  null,
        userId:       body.userId,
        containerTag: body.containerTag,
        title:        body.title     ?? null,
        content:      body.content,
        summary:      null,
        url:          body.url       ?? null,
        source:       body.source    ?? "api",
        type:         body.type      ?? "text",
        status:       "chunking",
        tokenCount:   null,
        wordCount:    body.content.split(/\s+/).length,
        metadata:     body.metadata  ?? null,
      });
      console.log(`[/v3/documents] Step 1 OK – docId: ${docId}`);

      // 2. Split content into overlapping chunks ──────────────────────────────
      const chunks = splitText(body.content, { chunkSize: 1500, chunkOverlap: 200 });
      console.log(`[/v3/documents] Step 2 OK – ${chunks.length} chunk(s)`);

      const ingestedMemoryIds: string[] = [];

      // 3. Process each chunk ─────────────────────────────────────────────────
      for (const chunk of chunks) {
        console.log(`[/v3/documents] Step 3 – processing chunk ${chunk.index}...`);

        // 3a. Embed the chunk
        const chunkEmbedding = await getEmbedding(AI, chunk.text);
        console.log(`[/v3/documents] Step 3a OK – embedding generated`);

        // 3b. Query MEMORIES_INDEX for candidates
        const vectorMatches = await queryVector(MEMORIES_INDEX, chunkEmbedding, 5);
        console.log(`[/v3/documents] Step 3b OK – ${vectorMatches.length} vector match(es)`);

        // 3c. Fetch full memory text for each matched ID from D1, resolving to latest version
        const candidateMemories = (
          await Promise.all(
            vectorMatches.map(async (match) => {
              // First fetch the matched memory row as-is
              const [matchedRow] = await db
                .select()
                .from(memories)
                .where(eq(memories.id, match.id));

              if (!matchedRow || matchedRow.isForgotten) {
                return null;
              }

              // If it's already the latest active version, return it
              if (matchedRow.isLatest) {
                return { id: matchedRow.id, memory: matchedRow.memory };
              }

              // Otherwise, follow the chain to get the latest active version
              const rootId = matchedRow.rootMemoryId || matchedRow.id;
              const [latestRow] = await db
                .select({ id: memories.id, memory: memories.memory })
                .from(memories)
                .where(
                  and(
                    eq(memories.rootMemoryId, rootId),
                    eq(memories.isLatest, true),
                    eq(memories.isForgotten, false)
                  )
                );

              return latestRow ?? null;
            })
          )
        ).filter((r): r is { id: string; memory: string } => r !== null);
        console.log(`[/v3/documents] Step 3c OK – ${candidateMemories.length} candidate(s)`);

        // 3d. Run fact extractor LLM
        const { facts } = await extractFacts(AI, chunk.text, candidateMemories);
        console.log(`[/v3/documents] Step 3d OK – ${facts.length} fact(s) extracted`);
        if (facts.length === 0) continue;

        // 3e. Batch embed all facts
        const factTexts = facts.map((f) => f.fact);
        const factEmbeddings = await getEmbeddings(AI, factTexts);
        console.log(`[/v3/documents] Step 3e OK – fact embeddings generated`);

        // 3f. Ingest each fact into D1 and Vectorize
        for (let i = 0; i < facts.length; i++) {
          const fact      = facts[i]!;
          const embedding = factEmbeddings[i]!;

          const relations = fact.targetId
            ? [{ type: fact.type as "updates" | "extends", targetId: fact.targetId }]
            : [];

          const newMemoryId = await ingestFactTransaction(db, {
            memoryText:   fact.fact,
            containerTag: body.containerTag,
            userId:       body.userId,
            documentId:   docId,
            relations,
          });
          console.log(`[/v3/documents] Step 3f OK – ingested ${newMemoryId}`);

          await upsertVector(MEMORIES_INDEX, newMemoryId, embedding, {
            userId:       body.userId,
            containerTag: body.containerTag,
            fact:         fact.fact,
          });

          if (fact.type === "updates" && fact.targetId) {
            await deleteVector(MEMORIES_INDEX, fact.targetId);
          }

          ingestedMemoryIds.push(newMemoryId);
        }
      }

      // 4. Mark document as done ────────────────────────────────────────────
      await db
        .update(documents)
        .set({ status: "done" })
        .where(eq(documents.id, docId));
      console.log("[/v3/documents] Step 4 OK – document marked done");

      return c.json({
        status:     "success",
        documentId: docId,
        chunks:     chunks.length,
        memories:   ingestedMemoryIds.length,
        memoryIds:  ingestedMemoryIds,
      }, 201);

    } catch (error) {
      const err = error as Error;
      console.error("[/v3/documents] FAILED:", err.message, err.stack);
      if (docId) {
        try {
          await db
            .update(documents)
            .set({ status: "failed" })
            .where(eq(documents.id, docId));
          console.log(`[/v3/documents] Marked document ${docId} as failed.`);
        } catch (updateErr) {
          console.error("[/v3/documents] Failed to mark document status as failed:", updateErr);
        }
      }
      return c.json({ status: "error", message: "Ingestion failed" }, 500);
    }
  }
);

export default app;
