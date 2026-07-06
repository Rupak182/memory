/**
 * Phase 6 E2E Verification
 * Verifies semantic search, recursive CTE graph traversal, and context injection chat endpoint.
 */
import { spawn } from "child_process";

interface ChatResponse {
  status: string;
  response: string;
  context: string;
}


interface DocumentPollResponse {
  status: string;
  document: {
    id: string;
    status: string;
    memoryIds: string[];
  };
}

import { join } from "path";

const serverPath = join(import.meta.dir, "..", "packages", "server");

async function runVerification() {
  console.log("Starting Wrangler dev server for Phase 6 verification...");
  
  const wrangler = spawn("bunx", ["wrangler", "dev", "--remote", "--port", "8888"], {
    cwd: serverPath,
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  let wranglerOutput = "";
  wrangler.stdout.on("data", (data: Buffer | string) => {
    wranglerOutput += data.toString();
    process.stdout.write(data);
  });

  wrangler.stderr.on("data", (data: Buffer | string) => {
    process.stderr.write(data);
  });

  wrangler.on("error", (err: Error) => {
    console.error("Failed to start wrangler process:", err);
    cleanExit(1);
  });

  // Safe timeout to abort if server takes too long to boot
  let bootTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    console.error("Timeout waiting for Wrangler server to be ready.");
    cleanExit(1);
  }, 90000);

  let testTimeout: ReturnType<typeof setTimeout> | null = null;

  function cleanExit(code: number) {
    if (bootTimeout) clearTimeout(bootTimeout);
    if (testTimeout) clearTimeout(testTimeout);
    console.log("Shutting down Wrangler server...");
    wrangler.once("exit", () => {
      console.log(`Wrangler exited. Exiting test runner with code ${code}`);
      process.exit(code);
    });
    wrangler.kill("SIGTERM");
    const forceExitTimeout = setTimeout(() => {
      console.log("Force exiting parent process.");
      process.exit(code);
    }, 3000);
    if (typeof forceExitTimeout === "object" && forceExitTimeout && "unref" in forceExitTimeout) {
      (forceExitTimeout as unknown as { unref: () => void }).unref();
    }
  }

  // Monitor stdout to find when server is listening
  while (true) {
    // eslint-disable-next-line no-control-regex
    const cleanOutput = wranglerOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
    if (cleanOutput.includes("Ready on http://localhost:8888") || cleanOutput.includes("Ready on http://127.0.0.1:8888")) {
      clearTimeout(bootTimeout!);
      bootTimeout = null;
      // Start test execution timeout (3 minutes max for entire pipeline)
      testTimeout = setTimeout(() => {
        console.error("Timeout: Test execution took too long.");
        cleanExit(1);
      }, 180000);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("\nWrangler ready on port 8888. Starting Phase 6 verification tests...\n");

  const userId = `user_p6_${Date.now()}`;
  const containerTag = `tag_p6_${Date.now()}`;

  try {
    // Helper to wait for background document processing to finish
    async function waitForDoc(documentId: string): Promise<string[]> {
      const maxAttempts = 15;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const pollRes = await fetch(`http://localhost:8888/v3/documents/${documentId}?userId=${userId}&containerTag=${containerTag}`);
        if (pollRes.ok) {
          const pollJson = (await pollRes.json()) as DocumentPollResponse;
          if (pollJson.status === "success" && pollJson.document.status === "done") {
            return pollJson.document.memoryIds;
          } else if (pollJson.status === "success" && pollJson.document.status === "failed") {
            throw new Error(`Document ${documentId} failed processing.`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error(`Timeout: Document ${documentId} did not process in time.`);
    }

    // ── STEP 1: Ingest Fact 1 ─────────────────────────────────────────────────
    console.log("Ingesting Fact 1: Alex works at Acme Corp...");
    const res1 = await fetch("http://localhost:8888/v3/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Alex works at Acme Corp as a senior system engineer.",
        userId,
        containerTag,
        source: "test",
        title: "Alex Job",
      }),
    });
    if (!res1.ok) {
      const txt = await res1.text();
      throw new Error(`Failed to ingest Fact 1: ${res1.status} - ${txt}`);
    }
    const json1 = (await res1.json()) as { status: string; documentId: string };
    console.log(`Document 1 queued: ${json1.documentId}. Waiting for processing...`);
    const memoryIds1 = await waitForDoc(json1.documentId);
    console.log(`Fact 1 Ingested successfully. Memory IDs: ${memoryIds1.join(", ")}`);

    // Wait a short moment for Vectorize index replication
    console.log("Waiting 10 seconds for Vectorize index replication of Fact 1...");
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // ── STEP 2: Ingest Fact 2 (Should link to Fact 1) ─────────────────────────
    console.log("Ingesting Fact 2: Acme Corp is based in San Francisco...");
    const res2 = await fetch("http://localhost:8888/v3/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Acme Corp is located in San Francisco, California.",
        userId,
        containerTag,
        source: "test",
        title: "Acme Location",
      }),
    });
    if (!res2.ok) {
      const txt = await res2.text();
      throw new Error(`Failed to ingest Fact 2: ${res2.status} - ${txt}`);
    }
    const json2 = (await res2.json()) as { status: string; documentId: string };
    console.log(`Document 2 queued: ${json2.documentId}. Waiting for processing...`);
    const memoryIds2 = await waitForDoc(json2.documentId);
    console.log(`Fact 2 Ingested successfully. Memory IDs: ${memoryIds2.join(", ")}`);

    console.log("Waiting 10 seconds for Vectorize index replication of Fact 2...");
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // ── STEP 3: Ingest Fact 3 (Should link to Fact 2) ─────────────────────────
    console.log("Ingesting Fact 3: San Francisco is in its rainy season...");
    const res3 = await fetch("http://localhost:8888/v3/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "San Francisco is experiencing a very wet rainy season.",
        userId,
        containerTag,
        source: "test",
        title: "SF Weather",
      }),
    });
    if (!res3.ok) {
      const txt = await res3.text();
      throw new Error(`Failed to ingest Fact 3: ${res3.status} - ${txt}`);
    }
    const json3 = (await res3.json()) as { status: string; documentId: string };
    console.log(`Document 3 queued: ${json3.documentId}. Waiting for processing...`);
    const memoryIds3 = await waitForDoc(json3.documentId);
    console.log(`Fact 3 Ingested successfully. Memory IDs: ${memoryIds3.join(", ")}`);

    console.log("Waiting 15 seconds for final index replication...");
    await new Promise((resolve) => setTimeout(resolve, 15000));

    // ── STEP 4: Query Chat Endpoint with maxDepth = 1 ─────────────────────────
    console.log("\nQuerying /v3/chat with maxDepth = 1 (Should find Acme Corp but NOT weather)...");
    const chatRes1 = await fetch("http://localhost:8888/v3/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Where does Alex work?" }],
        userId,
        containerTag,
        maxDepth: 1,
      }),
    });
    if (!chatRes1.ok) {
      const txt = await chatRes1.text();
      throw new Error(`Chat request failed: ${chatRes1.status} - ${txt}`);
    }
    const chatJson1 = (await chatRes1.json()) as ChatResponse;
    console.log("--- Context Injected (maxDepth = 1) ---");
    console.log(chatJson1.context);
    console.log("--- Response (maxDepth = 1) ---");
    console.log(chatJson1.response);

    // Verify context contains "Acme Corp"
    if (!chatJson1.context.toLowerCase().includes("acme corp")) {
      throw new Error("Expected context to contain Acme Corp");
    }

    // ── STEP 5: Query Chat Endpoint with maxDepth = 2 ─────────────────────────
    console.log("\nQuerying /v3/chat with maxDepth = 2 (Should traverse Acme Corp -> San Francisco -> Weather)...");
    const chatRes2 = await fetch("http://localhost:8888/v3/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Tell me about the weather where Alex's company is based." }],
        userId,
        containerTag,
        maxDepth: 2,
      }),
    });
    if (!chatRes2.ok) {
      const txt = await chatRes2.text();
      throw new Error(`Chat request failed: ${chatRes2.status} - ${txt}`);
    }
    const chatJson2 = (await chatRes2.json()) as ChatResponse;
    console.log("--- Context Injected (maxDepth = 2) ---");
    console.log(chatJson2.context);
    console.log("--- Response (maxDepth = 2) ---");
    console.log(chatJson2.response);

    console.log("\n✅ Phase 6 E2E verification complete: SUCCESS");
    cleanExit(0);
  } catch (error) {
    console.error("\n❌ Phase 6 E2E verification FAILED:", error);
    cleanExit(1);
  }
}

runVerification();
