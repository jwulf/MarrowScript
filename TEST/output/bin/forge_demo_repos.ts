/**
 * MarrowForge — 2-repo ingestion + forge demo (Phase 9 + 12)
 *
 * Drives the full pipeline against two real GitHub repos:
 *   1. Clone both via the ingest_repository cognition primitive (sandboxed,
 *      size-capped, deny-list aware, deterministic by (url, ref)).
 *   2. Analyze the pair on Tiny (Gemma) using analyze_repo_forge_request.
 *      Output is a JSON plan with target_symbol + ingredient hints.
 *   3. Generate the artifact via generate_forge_artifact (router picks
 *      Gemma for complexity ≤ 0.7, escalates to DeepSeek for heavier work).
 *   4. Print the trace span sequence and the artifact.
 *
 * No DB, no HTTP server — this calls the cognition runtime directly.
 *
 * Run with:
 *   cd output
 *   npx ts-node bin/forge_demo_repos.ts
 *
 * Requires:
 *   - LM Studio running on http://10.0.0.20:1234 with Gemma loaded
 *   - OPENAI_COMPAT_API_KEY set in .env (for OpenRouter / DeepSeek)
 *   - LLM_INGEST_ROOT (defaults to ./.forge-cache/ingest)
 *   - Network access to github.com
 */

import "./_load_env";

import { PROMPTS, runCognition } from "../src/cognition";
import { loadTrace } from "../src/cognition/traces";
import { newBudget } from "../src/cognition/budget";
import type { IngestReport } from "../src/cognition/ingest";
import { randomUUID, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

interface AnalysisShape {
  kind: string;
  summary: string;
  plan: string;
  target_symbol: string;
  complexity: number;
  ingredients_from_a?: string[];
  ingredients_from_b?: string[];
  graft_point?: string;
}

async function main(): Promise<void> {
  // ── Pick two small, stable, public repos for the demo. octocat/Hello-World
  //    is GitHub's canonical 1-file test repo (stable for a decade). For repo
  //    B we use github/gitignore — also small, stable, well-known. The preset
  //    `compare_apis` is non-codegen so we don't burn tokens producing TS.
  const request = {
    title: "Compare two reference repos",
    description:
      "Compare the file layouts of these two reference repos. Both are well-known, " +
      "small, and stable — this run is mostly here to exercise the ingest pipeline " +
      "and confirm both clones land in the sandbox cleanly.",
    preset: "compare_apis" as const,
    repo_a_url: "https://github.com/octocat/Hello-World",
    repo_a_ref: "HEAD",
    repo_b_url: "https://github.com/octocat/Spoon-Knife",
    repo_b_ref: "HEAD",
    target_path: "REPORT.md",
    complexity: 0.4,
  };

  console.log("MarrowForge demo — clone two repos, analyze, generate\n");
  console.log("Request:");
  console.log("  preset:      " + request.preset);
  console.log("  repo A:      " + request.repo_a_url);
  console.log("  repo B:      " + request.repo_b_url);
  console.log("  description: " + request.description);
  console.log("");

  const trace_id = randomUUID();
  const budget = newBudget(trace_id);

  // ── Step 1+2: ingest both repos in parallel. The Phase 9 primitive is
  //    pure (no model), so concurrency is safe.
  console.log("[1/3] Ingesting both repos…");
  const t0 = Date.now();
  const [repoA, repoB] = await Promise.all([
    runCognition("ingest_repository", { url: request.repo_a_url, ref: request.repo_a_ref }) as Promise<IngestReport>,
    runCognition("ingest_repository", { url: request.repo_b_url, ref: request.repo_b_ref }) as Promise<IngestReport>,
  ]);
  console.log("      done in " + (Date.now() - t0) + " ms");
  console.log("      Repo A → " + repoA.url_redacted);
  console.log("              files=" + repoA.file_count + ", bytes=" + repoA.total_bytes + ", sha=" + repoA.head_sha.slice(0, 12) + "…");
  console.log("      Repo B → " + repoB.url_redacted);
  console.log("              files=" + repoB.file_count + ", bytes=" + repoB.total_bytes + ", sha=" + repoB.head_sha.slice(0, 12) + "…");
  console.log("");

  // ── Step 2: analyze the pair on Tiny.
  console.log("[2/3] Analyzing on Tiny (Gemma @ LM Studio)…");
  const t1 = Date.now();
  const analysisRaw = await PROMPTS["analyze_repo_forge_request"](
    {
      title: request.title,
      description: request.description,
      preset: request.preset,
      repo_a_url: repoA.url_redacted,
      repo_a_files: repoA.file_count,
      repo_a_sha: repoA.head_sha,
      repo_b_url: repoB.url_redacted,
      repo_b_files: repoB.file_count,
      repo_b_sha: repoB.head_sha,
    },
    { trace_id, budget },
  );
  console.log("      done in " + (Date.now() - t1) + " ms");

  let analysis: AnalysisShape | null = null;
  if (typeof analysisRaw === "string") {
    try { analysis = JSON.parse(analysisRaw) as AnalysisShape; } catch { /* keep raw */ }
  }
  if (analysis) {
    console.log("      kind          = " + analysis.kind);
    console.log("      summary       = " + analysis.summary);
    console.log("      target_symbol = " + analysis.target_symbol);
    console.log("      complexity    = " + analysis.complexity);
    if (analysis.ingredients_from_a) console.log("      from A        = " + JSON.stringify(analysis.ingredients_from_a));
    if (analysis.ingredients_from_b) console.log("      from B        = " + JSON.stringify(analysis.ingredients_from_b));
    if (analysis.graft_point) console.log("      graft_point   = " + analysis.graft_point);
  } else {
    console.log("      raw: " + String(analysisRaw).slice(0, 300));
  }
  console.log("");

  // ── Step 3: generate the artifact. Preset chooses prompt: code vs report.
  console.log("[3/3] Generating artifact…");
  const complexity = analysis?.complexity ?? request.complexity;
  const targetSymbol = analysis?.target_symbol ?? "RepoComparisonReport";
  const isReport = request.preset === "compare_apis" || request.preset === "migrate";
  const generatorName = isReport ? "generate_forge_report" : "generate_forge_artifact";
  console.log("      preset=" + request.preset + " → " + generatorName + " (validate=" + (isReport ? "schema_only" : "ast_compiles") + ")");
  console.log("      router will pick: " + (complexity <= 0.7 ? "Gemma / LM Studio" : "DeepSeek / OpenRouter"));
  const t2 = Date.now();
  const artifactRaw = await PROMPTS[generatorName](
    {
      plan: typeof analysisRaw === "string" ? analysisRaw : JSON.stringify(analysisRaw),
      target_symbol: targetSymbol,
      files: JSON.stringify({
        repo_a: { url: repoA.url_redacted, files: repoA.file_count, sha: repoA.head_sha },
        repo_b: { url: repoB.url_redacted, files: repoB.file_count, sha: repoB.head_sha },
      }),
      desired_kind: request.preset,
      target_path: request.target_path,
      description: request.description,
      complexity,
    },
    { trace_id, budget },
  );
  console.log("      done in " + (Date.now() - t2) + " ms");
  console.log("");

  // ── Show the artifact.
  console.log("─── Generated artifact ────────────────────────────────────");
  const text = typeof artifactRaw === "string" ? artifactRaw : JSON.stringify(artifactRaw, null, 2);
  console.log(text.slice(0, 4000));
  if (text.length > 4000) console.log("\n  …(truncated, full length=" + text.length + ")");
  console.log("─" + "─".repeat(58));
  console.log("");

  // ── Show the trace.
  console.log("Trace " + trace_id + ":");
  const spans = await loadTrace(trace_id);
  const sortedSpans = [...spans].sort((a, b) => a.started_at - b.started_at);
  for (const s of sortedSpans) {
    const usage =
      (s.prompt_tokens ?? 0) + (s.completion_tokens ?? 0) > 0
        ? "  " + (s.prompt_tokens ?? 0) + " in / " + (s.completion_tokens ?? 0) + " out"
        : "";
    const conf = typeof s.confidence === "number" ? "  conf=" + s.confidence.toFixed(3) : "";
    const cache = s.cache_hit ? "  CACHE" : "";
    const validate = s.validate_result ? "  validate=" + s.validate_result : "";
    console.log(
      "  [" +
        s.kind.padEnd(15) +
        "] " +
        s.status.padEnd(18) +
        "  " +
        (s.model ?? "-").padEnd(40) +
        "  " +
        s.latency_ms.toString().padStart(5) +
        "ms" +
        usage +
        conf +
        cache +
        validate,
    );
  }
  console.log("");
  console.log("Total budget consumed: " + budget.tokens + " tokens, $" + budget.usd.toFixed(6));

  // ── Phase 12: assemble the typed ForgeResult and persist it.
  //
  //    The pipeline produced everything we need: analysis (the JSON plan
  //    Tiny returned), artifact (the code/markdown the generator returned),
  //    and a trace_id linking the whole thing back to cognition_traces.
  //    We assemble those into a ForgeResult-shaped object and save it to
  //    disk under .forge-cache/results/<id>.json. In production the same
  //    payload would POST to /forge_results/save-forge-result (the route
  //    the framework already generates) where it would land in Postgres
  //    inside a transaction with an `ArtifactForged` event in the outbox.
  //
  //    Saving locally here gives the same UX (a durable, inspectable
  //    artifact per run) without requiring the DB to be up.

  const generatorSpan = sortedSpans.find(s => s.prompt === generatorName && s.status === "ok");
  const tierUsed = generatorSpan?.model ?? null;
  const confidence = typeof generatorSpan?.confidence === "number" ? generatorSpan.confidence : null;
  const artifactText = typeof artifactRaw === "string" ? artifactRaw : JSON.stringify(artifactRaw);

  const result = {
    id: randomUUID(),
    request_id: createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32),
    kind: analysis?.kind ?? request.preset,
    summary: analysis?.summary ?? request.title,
    target_path: request.target_path,
    target_symbol: targetSymbol,
    artifact: artifactText,
    plan: analysis?.plan ?? "",
    confidence,
    ast_compiles: !isReport,
    tier_used: tierUsed,
    trace_id,
    preset: request.preset,
    repo_a: { url: repoA.url_redacted, files: repoA.file_count, sha: repoA.head_sha },
    repo_b: { url: repoB.url_redacted, files: repoB.file_count, sha: repoB.head_sha },
    budget: { tokens: budget.tokens, usd: budget.usd },
    spans: sortedSpans.map(s => ({
      kind: s.kind,
      status: s.status,
      model: s.model ?? null,
      prompt: s.prompt ?? null,
      latency_ms: s.latency_ms,
      cache_hit: !!s.cache_hit,
      confidence: typeof s.confidence === "number" ? s.confidence : null,
      validate_result: s.validate_result ?? null,
    })),
    created_at: new Date().toISOString(),
  };

  const outDir = path.resolve(".forge-cache", "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, result.id + ".json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log("");
  console.log("Saved ForgeResult -> " + outPath);
  console.log("  id          " + result.id);
  console.log("  request_id  " + result.request_id);
  console.log("  kind        " + result.kind);
  console.log("  tier_used   " + (result.tier_used ?? "-"));
  console.log("  confidence  " + (result.confidence ?? "-"));
}

main().catch((err: Error) => {
  console.error("FAIL:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
