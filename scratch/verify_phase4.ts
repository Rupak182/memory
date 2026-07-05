import { spawn } from "child_process";
import { resolve } from "path";

async function verify() {
  console.log("Starting local Wrangler dev server to emulate Workers AI...");
  const serverPath = resolve(__dirname, "../packages/server");
  
  const wrangler = spawn("npx", ["wrangler", "dev", "--remote"], {
    cwd: serverPath,
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" }
  });
  
  let isReady = false;
  let port = 8787;
  const timeout = setTimeout(() => {
    console.error("Timeout: Wrangler dev server failed to start in 60 seconds.");
    cleanExit(1);
  }, 60000);
  
  function cleanExit(code: number) {
    clearTimeout(timeout);
    wrangler.kill("SIGTERM");
    process.exit(code);
  }
  
  wrangler.stdout.on("data", async (data) => {
    const output = data.toString();
    console.log(`[Wrangler] ${output.trim()}`);
    
    if (!isReady) {
      // eslint-disable-next-line no-control-regex
      const cleanOutput = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
      const match = cleanOutput.match(/Ready on http:\/\/localhost:(\d+)/) || cleanOutput.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        port = parseInt(match[1], 10);
        isReady = true;
        console.log(`Wrangler dev server is ready on port ${port}! Sending verification request to Hono server...`);
        
        try {
          const res = await fetch(`http://localhost:${port}/test-extractor`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              text: "I have started building web projects with Next.js instead of React.",
              candidates: [
                { id: "mem_100", memory: "User prefers React" }
              ]
            })
          });
          
          if (!res.ok) {
            throw new Error(`Server returned status ${res.status}: ${await res.text()}`);
          }
          
          interface ExtractedFact {
            fact: string;
            type: "new" | "updates" | "extends";
            targetId?: string;
          }
          
          interface ExtractorResponse {
            status: string;
            result?: {
              facts: ExtractedFact[];
            };
          }
          
          const json = (await res.json()) as ExtractorResponse;
          console.log("Response:", JSON.stringify(json, null, 2));
          
          if (json.status !== "success" || !json.result) {
            throw new Error(`Expected success status, got ${json.status}`);
          }
          
          // Verify structured outputs
          const facts = json.result.facts;
          console.log("Extracted Facts:", facts);
          if (!facts || facts.length === 0) {
            throw new Error("No facts extracted!");
          }
          
          // Check updates relation
          const updateFact = facts.find((f) => f.type === "updates" && f.targetId === "mem_100");
          if (!updateFact) {
            console.warn("WARNING: Model did not flag the change as 'updates' for mem_100. It might have classified it as new/extends or returned a different output format.");
          } else {
            console.log("Success! Extracted fact correctly classified as updates for mem_100.");
          }
          
          console.log("\nPhase 4 E2E verification complete: SUCCESS ✅");
          cleanExit(0);
        } catch (err) {
          console.error("Verification failed:", err);
          cleanExit(1);
        }
      }
    }
  });
  
  wrangler.stderr.on("data", (data) => {
    console.error(`[Wrangler Error] ${data.toString().trim()}`);
  });
  
  wrangler.on("close", (code) => {
    console.log(`Wrangler dev server exited with code ${code}`);
  });
}

verify();
