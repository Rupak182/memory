import { Hono } from "hono";
import {
  getDb, users, documents, memories, memoryDocumentSources,
  getEmbedding, getEmbeddings, queryVector,
  insertDocument, ingestFactTransaction, upsertVector, deleteVector,
  getRelatedMemories, getProfileMemories,
  eq, and, inArray, or, gt, ne,
  type GraphMemory,
} from "@memory/database";
import { SHARED_VERSION } from "@memory/shared";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { extractFacts } from "./extractor";
import { splitText } from "./splitter";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";

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
        status:       "queued",
        tokenCount:   null,
        wordCount:    body.content.split(/\s+/).length,
        metadata:     body.metadata  ?? null,
      });
      console.log(`[/v3/documents] Step 1 OK – docId: ${docId}`);

      // 2. Split content into overlapping chunks ──────────────────────────────
      const chunks = splitText(body.content, { chunkSize: 1500, chunkOverlap: 200 });
      console.log(`[/v3/documents] Step 2 OK – ${chunks.length} chunk(s)`);

      const processPromise = (async () => {
        try {
          await db
            .update(documents)
            .set({ status: "chunking" })
            .where(eq(documents.id, docId!));

          const ingestedMemoryIds: string[] = [];

          // 3. Process each chunk ─────────────────────────────────────────────────
          for (const chunk of chunks) {
            console.log(`[/v3/documents] Step 3 – processing chunk ${chunk.index}...`);

            // 3a. Embed the chunk
            const chunkEmbedding = await getEmbedding(AI, chunk.text);
            console.log(`[/v3/documents] Step 3a OK – embedding generated`);

            // 3b. Query MEMORIES_INDEX for candidates
            const vectorMatches = await queryVector(MEMORIES_INDEX, chunkEmbedding, 5, {
              userId: body.userId,
              containerTag: body.containerTag,
            });
            console.log(`[/v3/documents] Step 3b OK – ${vectorMatches.length} vector match(es)`);

            // 3c. Fetch full memory text for each matched ID from D1, resolving to latest version
            const candidateMemories = (
              await Promise.all(
                vectorMatches.map(async (match) => {
                  const [matchedRow] = await db
                    .select()
                    .from(memories)
                    .where(eq(memories.id, match.id));

                  if (!matchedRow || matchedRow.isForgotten) {
                    return null;
                  }

                  if (matchedRow.isLatest) {
                    return { id: matchedRow.id, memory: matchedRow.memory };
                  }

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
                documentId:   docId!,
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
            .where(eq(documents.id, docId!));
          console.log(`[/v3/documents] Step 4 OK – document ${docId} marked done`);

        } catch (error) {
          const err = error as Error;
          console.error(`[/v3/documents] FAILED for ${docId}:`, err.message, err.stack);
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
        }
      })();

      let executionCtx: { waitUntil: (promise: Promise<unknown>) => void } | undefined = undefined;
      try {
        executionCtx = c.executionCtx;
      } catch {
        executionCtx = undefined;
      }

      if (executionCtx) {
        executionCtx.waitUntil(processPromise);
        return c.json({
          status:     "success",
          documentId: docId,
          message:    "Document queued for background processing",
        }, 202);
      } else {
        await processPromise;
        const memoriesFromDb = await db
          .select({ id: memories.id })
          .from(memories)
          .innerJoin(memoryDocumentSources, eq(memories.id, memoryDocumentSources.memoryEntryId))
          .where(eq(memoryDocumentSources.documentId, docId));

        return c.json({
          status:     "success",
          documentId: docId,
          chunks:     chunks.length,
          memories:   memoriesFromDb.length,
          memoryIds:  memoriesFromDb.map((m) => m.id),
        }, 201);
      }

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

app.get(
  "/v3/documents/:id",
  async (c) => {
    const { id } = c.req.param();
    const { DB } = c.env;
    const db = getDb(DB);

    const queryParams = c.req.query();
    const userId = queryParams.userId || c.req.header("x-user-id");
    const containerTag = queryParams.containerTag || c.req.header("x-container-tag");

    if (!userId || !containerTag) {
      return c.json({
        status: "error",
        message: "userId and containerTag query parameters or headers are required for tenant scoping"
      }, 400);
    }

    try {
      const [doc] = await db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.id, id),
            eq(documents.userId, userId),
            eq(documents.containerTag, containerTag)
          )
        );

      if (!doc) {
        return c.json({ status: "error", message: "Document not found" }, 404);
      }

      const ingestedMemories = await db
        .select({ id: memories.id })
        .from(memories)
        .innerJoin(memoryDocumentSources, eq(memories.id, memoryDocumentSources.memoryEntryId))
        .where(eq(memoryDocumentSources.documentId, id));

      return c.json({
        status: "success",
        document: {
          id: doc.id,
          customId: doc.customId,
          status: doc.status,
          title: doc.title,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          memoryIds: ingestedMemories.map((m) => m.id),
        }
      });
    } catch (error) {
      const err = error as Error;
      console.error(`[GET /v3/documents/${id}] FAILED:`, err.message);
      return c.json({ status: "error", message: "Failed to retrieve document status" }, 500);
    }
  }
);

/**
 * Format retrieved memory nodes into a clean Markdown list within a token/character budget.
 */
function formatMemoriesToContext(
  memoriesList: { id: string; memory: string; depth?: number }[],
  tokenBudget = 1500
): string {
  const charLimit = tokenBudget * 4;
  let context = "";
  let currentLength = 0;

  // Sort by depth (hop distance) ascending
  const sorted = [...memoriesList].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));

  // Deduplicate exact semantic duplicates
  const seen = new Set<string>();

  for (const item of sorted) {
    const cleanMemory = item.memory.trim();
    if (seen.has(cleanMemory)) continue;
    seen.add(cleanMemory);

    const line = `- ${cleanMemory}\n`;
    if (currentLength + line.length > charLimit) {
      break;
    }
    context += line;
    currentLength += line.length;
  }

  return context.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6: Search & Context Injection Chat Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1, "messages list cannot be empty"),
  userId: z.string().min(1, "userId is required"),
  containerTag: z.string().min(1, "containerTag is required"),
  maxDepth: z.number().int().min(1).max(5).default(2),
});

app.post(
  "/v3/chat",
  zValidator("json", ChatRequestSchema),
  async (c) => {
    const body = c.req.valid("json");
    const { AI, DB, MEMORIES_INDEX } = c.env;
    const db = getDb(DB);

    try {
      // 1. Retrieve user's last message to fetch semantic context
      const lastUserMessage = body.messages
        .filter((m) => m.role === "user")
        .pop()?.content || "";

      let relatedMemories: GraphMemory[] = [];
      if (lastUserMessage) {
        // 2. Embed user search query
        const queryEmbed = await getEmbedding(AI, lastUserMessage);

        // 3. Perform semantic seed search in Vectorize
        const vectorMatches = await queryVector(MEMORIES_INDEX, queryEmbed, 5, {
          userId: body.userId,
          containerTag: body.containerTag,
        });
        const seedIds = vectorMatches.map((m) => m.id);

        // 4. Recursive CTE Graph Traversal up to maxDepth hops
        if (seedIds.length > 0) {
          relatedMemories = await getRelatedMemories(
            db,
            seedIds,
            body.userId,
            body.containerTag,
            body.maxDepth
          );
        }
      }

      // 5b. Fetch raw content of unprocessed (queued/chunking) or recently done (last 120s) documents
      // This bridges the temporary "black hole" while Vectorize replicates new vector indexes.
      const recentDoneCutoff = new Date(Date.now() - 120000);
      const unprocessedDocs = await db
        .select({ content: documents.content, title: documents.title })
        .from(documents)
        .where(
          and(
            eq(documents.userId, body.userId),
            eq(documents.containerTag, body.containerTag),
            ne(documents.type, "chat"), // Exclude chat history to avoid prompt duplication
            or(
              inArray(documents.status, ["queued", "chunking"]),
              and(
                eq(documents.status, "done"),
                gt(documents.updatedAt, recentDoneCutoff)
              )
            )
          )
        );

      let unprocessedContext = "";
      if (unprocessedDocs.length > 0) {
        let budget = 30000;
        const docsContexts: string[] = [];
        let limitReached = false;
        
        for (const d of unprocessedDocs) {
          const rawContent = d.content || "";
          let docText = "";
          if (rawContent.length > 10000) {
            docText = `Document "${d.title ?? 'Untitled'}" (Truncated - full indexing in progress):\n${rawContent.substring(0, 10000)}\n[...Content truncated due to size...]`;
          } else {
            docText = `Document "${d.title ?? 'Untitled'}":\n${rawContent}`;
          }
          
          if (budget - docText.length >= 0) {
            docsContexts.push(docText);
            budget -= docText.length;
          } else {
            if (budget > 1000) {
              const slicedText = docText.substring(0, budget);
              docsContexts.push(`${slicedText}\n[...Content truncated to fit context limits...]`);
            }
            limitReached = true;
            break;
          }
        }
        
        unprocessedContext = "\n\nThe following documents are currently being processed in the background and their raw content is provided below:\n" +
          docsContexts.join("\n\n");
          
        if (limitReached) {
          unprocessedContext += "\n\n[Note: Additional background documents are being indexed but were omitted from this context to fit model size limits.]";
        }
      }

      // 5. Fetch profile memories (static preferences + 10 recent dynamic)
      const profileMemories = await getProfileMemories(db, body.userId, body.containerTag);

      // 6. Deduplicate & format context
      const combined = [...relatedMemories, ...profileMemories];
      const contextText = formatMemoriesToContext(combined, 1500);

      // 7. Inject context into Chat System Prompt
      const systemPrompt = `You are a helpful assistant. You have access to the following relevant memories about the user:

${contextText || "No relevant memories found."}${unprocessedContext}

Please use these memories and document context to personalize your response where relevant. Do not mention that you are using this context unless asked.`;

      // 8. Generate chat response using Llama 3
      const aiProvider = createWorkersAI({ binding: AI });
      const model = aiProvider("@cf/meta/llama-3.1-8b-instruct-fp8");

      const { text: responseText } = await generateText({
        model,
        system: systemPrompt,
        messages: body.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
      });

      return c.json({
        status: "success",
        response: responseText,
        context: contextText,
      });
    } catch (error) {
      const err = error as Error;
      console.error("[/v3/chat] FAILED:", err.message, err.stack);
      return c.json({ status: "error", message: "Chat request failed" }, 500);
    }
  }
);

export default app;
