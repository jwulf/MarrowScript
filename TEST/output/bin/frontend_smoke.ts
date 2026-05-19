/**
 * Frontend integration smoke test.
 *
 * Runs the same HTTP path a real frontend would: mint a token, POST
 * /repo_forge_requests/forge-from-repos with the inline body, GET the
 * trace, render a quick summary. No DB required — everything cognition-
 * pipeline is in-memory.
 *
 * Run with:
 *   npx ts-node src/index.ts          # in one terminal (start the server)
 *   npx ts-node bin/frontend_smoke.ts # in another (run this file)
 *
 * If you have axios / fetch / your-favorite-react-query in the frontend,
 * the request shapes below are exactly what you'd send.
 */

import "./_load_env";
import * as jwt from "jsonwebtoken";

const BASE = process.env.MARROWFORGE_BASE || "http://localhost:3000";

function mintToken(sub: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set in .env");
  return jwt.sign({ sub }, secret, { algorithm: "HS256", expiresIn: "1h" });
}

async function post<T>(path: string, body: unknown, token: string): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("POST " + path + " " + res.status + ": " + text);
  }
  return (await res.json()) as T;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("GET " + path + " " + res.status + ": " + text);
  }
  return (await res.json()) as T;
}

interface ForgeResponse {
  ok: boolean;
  action: string;
  trace_id: string | null;
  results: {
    repo_a: { url_redacted: string; file_count: number; head_sha: string };
    repo_b: { url_redacted: string; file_count: number; head_sha: string };
    analysis: string;
    artifact: string;
  };
}

interface TraceResponse {
  trace_id: string;
  span_count: number;
  spans: Array<{
    kind: string;
    status: string;
    model: string | null;
    prompt: string | null;
    latency_ms: number;
    cache_hit: boolean;
  }>;
}

async function main(): Promise<void> {
  console.log("MarrowForge frontend smoke test (target: " + BASE + ")\n");

  // 1. Mint a dev token. Real frontends get this from their auth provider.
  const token = mintToken("frontend-smoke");
  console.log("[1] Token minted (" + token.length + " chars)");

  // 2. Health check.
  const health = await get<{ status: string }>("/health/live", token);
  console.log("[2] Health: " + health.status);

  // 3. Forge from repos. Inline mode — no separate POST /repo_forge_requests
  //    needed. The body is the full RepoForgeRequest entity.
  const forgeRequest = {
    title: "Frontend smoke",
    description: "End-to-end HTTP test from a frontend-style fetch caller.",
    preset: "compare_apis",
    repo_a_url: "https://github.com/octocat/Hello-World",
    repo_a_ref: "HEAD",
    repo_b_url: "https://github.com/octocat/Spoon-Knife",
    repo_b_ref: "HEAD",
    target_path: "REPORT.md",
    complexity: 0.4,
  };
  console.log("[3] POST /repo_forge_requests/forge-from-repos …");
  const t0 = Date.now();
  const forge = await post<ForgeResponse>("/repo_forge_requests/forge-from-repos", forgeRequest, token);
  console.log("    done in " + (Date.now() - t0) + " ms");
  console.log("    ok        = " + forge.ok);
  console.log("    trace_id  = " + forge.trace_id);
  console.log("    repo_a    = " + forge.results.repo_a.file_count + " files, sha " + forge.results.repo_a.head_sha.slice(0, 12));
  console.log("    repo_b    = " + forge.results.repo_b.file_count + " files, sha " + forge.results.repo_b.head_sha.slice(0, 12));
  console.log("    artifact  = " + forge.results.artifact.slice(0, 80) + "…");
  console.log("");

  // 4. Fetch the trace. Frontend renders this as a timeline.
  if (forge.trace_id) {
    console.log("[4] GET /cognition_traces/" + forge.trace_id);
    const trace = await get<TraceResponse>("/cognition_traces/" + forge.trace_id, token);
    console.log("    span_count = " + trace.span_count);
    for (const span of trace.spans) {
      const cache = span.cache_hit ? " CACHE" : "";
      console.log(
        "    [" +
          span.kind.padEnd(15) +
          "] " +
          span.status.padEnd(15) +
          " " +
          (span.model ?? "-").padEnd(10) +
          " " +
          span.latency_ms +
          "ms" +
          cache,
      );
    }
  }

  console.log("\nFrontend smoke test passed.");
}

main().catch((err: Error) => {
  console.error("\nFAIL:", err.message);
  process.exit(1);
});
