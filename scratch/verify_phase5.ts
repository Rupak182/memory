/**
 * Phase 5 E2E Verification
 * Tests the full document ingestion pipeline:
 *   POST /v3/documents → chunk → embed → extract facts → ingest to D1 + Vectorize
 */

import { spawn } from "child_process";
import { join } from "path";

const serverPath = join(import.meta.dir, "..", "packages", "server");

interface IngestResponse {
  status: string;
  documentId: string;
  chunks: number;
  memories: number;
  memoryIds: string[];
}

async function main() {
  console.log("Starting Wrangler dev server for Phase 5 verification...");

  const wrangler = spawn("bunx", ["wrangler", "dev", "--remote", "--port", "8888"], {
    cwd: serverPath,
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  let isReady = false;
  let port = 8888;

  const timeout = setTimeout(() => {
    console.error("Timeout: Wrangler dev server failed to start in 90 seconds.");
    cleanExit(1);
  }, 90000);

  function cleanExit(code: number) {
    clearTimeout(timeout);
    wrangler.once("exit", () => process.exit(code));
    wrangler.kill("SIGTERM");
    // Fallback in case the child doesn't exit promptly
    setTimeout(() => process.exit(code), 3000).unref();
  }

  wrangler.on("error", (err) => {
    console.error("Failed to start wrangler process:", err);
    cleanExit(1);
  });

  wrangler.stdout.on("data", async (data) => {
    const output = data.toString();
    process.stdout.write(`[Wrangler] ${output}`);

    if (!isReady) {
      // eslint-disable-next-line no-control-regex
      const clean = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
      const match = clean.match(/Ready on http:\/\/localhost:(\d+)/) || clean.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        port = parseInt(match[1]!, 10);
        isReady = true;
        console.log(`\nWrangler ready on port ${port}. Sending ingestion request...\n`);

        try {
          const res = await fetch(`http://localhost:${port}/v3/documents`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `
                My name is Alice and I am a backend engineer.
                I have 5 years of experience with TypeScript and Node.js.
                I recently started using Bun as my JavaScript runtime because it is faster.
                I also enjoy working with Cloudflare Workers for edge computing.
              `.trim(),
              userId:       "user_test_001",
              containerTag: "test_phase5",
              title:        "Alice's Profile",
              source:       "test",
            }),
          });

          if (!res.ok) {
            const text = await res.text();
            console.error("Request failed:", res.status, text);
            cleanExit(1);
            return;
          }

          const json = await res.json() as IngestResponse;
          console.log("Ingestion Response:", JSON.stringify(json, null, 2));

          // Assertions
          if (json.status !== "success") {
            throw new Error(`Expected status "success", got "${json.status}"`);
          }
          if (!json.documentId.startsWith("doc_")) {
            throw new Error(`documentId should start with "doc_", got "${json.documentId}"`);
          }
          if (json.chunks < 1) {
            throw new Error(`Expected at least 1 chunk, got ${json.chunks}`);
          }
          if (json.memories < 1) {
            throw new Error(`Expected at least 1 memory to be ingested, got ${json.memories}`);
          }
          if (!Array.isArray(json.memoryIds) || json.memoryIds.some((id) => !id.startsWith("mem_"))) {
            throw new Error("All memoryIds should start with 'mem_'");
          }

          console.log(`\n✅ Phase 5 E2E verification complete: SUCCESS`);
          console.log(`   Document ID : ${json.documentId}`);
          console.log(`   Chunks      : ${json.chunks}`);
          console.log(`   Memories    : ${json.memories}`);
          console.log(`   Memory IDs  : ${json.memoryIds.join(", ")}`);

          cleanExit(0);
        } catch (err) {
          console.error("Verification failed:", err);
          cleanExit(1);
        }
      }
    }
  });

  wrangler.stderr.on("data", (data) => {
    process.stderr.write(`[Wrangler:err] ${data.toString()}`);
  });

  wrangler.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`Wrangler exited with code ${code}`);
      cleanExit(1);
    }
  });
}

main();
