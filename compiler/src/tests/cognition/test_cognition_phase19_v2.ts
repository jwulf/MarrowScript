/**
 * MarrowScript Cognition Phase 19 v2 Tests — router tuner
 *
 * Verifies the offline tuner that aggregates recorded cognition traces
 * against a router's policy:
 *   1. tuneRouter computes per-tier metrics from a span list.
 *   2. Latency p50/p95 percentiles compute correctly.
 *   3. cost_usd_per_call and tokens_per_call aggregate correctly.
 *   4. Validation pass rate computes correctly.
 *   5. Confidence mean handles missing values.
 *   6. evaluateConstraint parses the serialised IR shape and checks per-tier.
 *   7. Suggestions fire on the documented patterns:
 *      - low call volume → "collect more traces"
 *      - failing tier vs passing later tier → "lower max"
 *      - cheap tier passes everything → "raise max"
 *   8. formatTuneReport produces the documented human-readable shape.
 *   9. Determinism — two runs with the same input produce identical reports.
 */

import { Lexer } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";
import {
  tuneRouter,
  formatTuneReport,
  type TraceSpanLike,
} from "../tune_router";

let passed = 0;
let failed = 0;

function ok(name: string): void { console.log(`  v ${name}`); passed++; }
function fail(name: string, msg: string): void { console.log(`  x ${name}: ${msg}`); failed++; }

function compile(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) throw new Error("type check: " + errs.map(e => e.code + ":" + e.message).join("; "));
  return new Lowering().lower(ast, "phase19v2-test")[0];
}

console.log("MarrowScript Cognition Phase 19 v2 Tests — router tuner\n");

// ─── Fixture: a router with policy + recorded spans ───────────────────────

const sys = compile(`
  system Phase19V2 {
    model Tiny {
      provider: ollama
      name: "qwen2.5:1.5b"
      context_window: 8000
      max_output: 256
      cost_class: tiny
    }
    model Medium {
      provider: openai_compat
      endpoint: "http://localhost:8080/v1"
      name: "phi-3.5"
      context_window: 32000
      max_output: 1024
      cost_class: medium
    }
    router smart_router {
      by: input.complexity
      observe: ["validation_pass_rate", "latency_p95_ms", "cost_usd_per_call"]
      tier easy { max: 0.6 -> Tiny }
      tier hard { -> Medium }
      policy: minimize_cost_subject_to {
        validation_pass_rate >= 0.9
        latency_p95_ms <= 30000
      }
      fallback: Medium
    }
  }
`);
const router = sys.routers[0];

// Build a synthetic span list. Tier "easy" gets 100 calls, 80 ok / 20 validate_failed.
// Tier "hard" gets 50 calls, all ok.
function makeSpan(i: number, tier: string, status: string, latencyMs: number, costUsd: number, tokens: number, conf: number): TraceSpanLike {
  return {
    span_id: `s${tier}-${String(i).padStart(4, "0")}`,
    workflow: "smart_router",
    step: "chat",
    kind: "prompt_call",
    prompt: "p",
    model: tier === "easy" ? "Tiny" : "Medium",
    status,
    prompt_tokens: tokens / 2,
    completion_tokens: tokens / 2,
    cost_usd: costUsd,
    latency_ms: latencyMs,
    confidence: conf,
    metadata: { tier },
  };
}

const spans: TraceSpanLike[] = [];
// Tier "easy": 100 calls, 80 ok, 20 validate_failed.
for (let i = 0; i < 80; i++) spans.push(makeSpan(i, "easy", "ok", 100 + i, 0.0001, 200, 0.9));
for (let i = 0; i < 20; i++) spans.push(makeSpan(80 + i, "easy", "validate_failed", 200 + i, 0.0001, 200, 0.5));
// Tier "hard": 50 calls, all ok, slower + more expensive.
for (let i = 0; i < 50; i++) spans.push(makeSpan(i, "hard", "ok", 5000 + i * 10, 0.001, 1500, 0.95));
// Add a non-prompt_call span to verify filtering.
spans.push({ span_id: "validate-1", kind: "validate", status: "ok" });

// ─── Section 1: per-tier aggregation ──────────────────────────────────────

console.log("Section 1: per-tier aggregation");

{
  const report = tuneRouter(router, spans);
  if (report.prompt_call_spans === 150) ok(`prompt_call_spans: 150 (validate filtered)`);
  else fail("prompt_call count", String(report.prompt_call_spans));

  const easy = report.tiers.find(t => t.tier === "easy")!;
  if (easy.calls === 100) ok("easy: 100 calls");
  else fail("easy calls", String(easy.calls));
  if (easy.ok_calls === 80) ok("easy: 80 ok");
  else fail("easy ok", String(easy.ok_calls));
  if (easy.validate_failed === 20) ok("easy: 20 validate_failed");
  else fail("easy fail", String(easy.validate_failed));
  if (Math.abs(easy.validation_pass_rate - 0.8) < 0.001) ok("easy: pass_rate=0.8");
  else fail("easy rate", String(easy.validation_pass_rate));

  const hard = report.tiers.find(t => t.tier === "hard")!;
  if (hard.calls === 50) ok("hard: 50 calls");
  else fail("hard calls", String(hard.calls));
  if (Math.abs(hard.validation_pass_rate - 1.0) < 0.001) ok("hard: pass_rate=1.0");
  else fail("hard rate", String(hard.validation_pass_rate));
}

// ─── Section 2: percentiles ───────────────────────────────────────────────

console.log("\nSection 2: latency percentiles");

{
  const report = tuneRouter(router, spans);
  const easy = report.tiers.find(t => t.tier === "easy")!;
  // 100 latencies: ok latencies 100..179 (80 values, indexes 0..79),
  // validate_failed latencies 200..219 (20 values, indexes 80..99).
  // Sorted ascending: index 50 = 100 + 50 = 150 (still in the ok range);
  // index 95 = 200 + (95 - 80) = 215.
  if (easy.latency_p50_ms === 150) ok("easy: p50=150ms");
  else fail("easy p50", String(easy.latency_p50_ms));
  if (easy.latency_p95_ms === 215) ok("easy: p95=215ms");
  else fail("easy p95", String(easy.latency_p95_ms));

  const hard = report.tiers.find(t => t.tier === "hard")!;
  // 50 latencies: 5000, 5010, ..., 5490. p95 idx 47 = 5470.
  if (hard.latency_p95_ms === 5470) ok("hard: p95=5470ms");
  else fail("hard p95", String(hard.latency_p95_ms));
}

// ─── Section 3: cost + tokens ─────────────────────────────────────────────

console.log("\nSection 3: cost + tokens");

{
  const report = tuneRouter(router, spans);
  const easy = report.tiers.find(t => t.tier === "easy")!;
  // 100 calls × 0.0001 / 100 = 0.0001 per call.
  if (Math.abs(easy.cost_usd_per_call - 0.0001) < 0.0000001) ok("easy: cost/call=0.0001");
  else fail("easy cost/call", String(easy.cost_usd_per_call));
  if (easy.tokens_per_call === 200) ok("easy: tokens/call=200");
  else fail("easy tokens/call", String(easy.tokens_per_call));

  const hard = report.tiers.find(t => t.tier === "hard")!;
  if (Math.abs(hard.cost_usd_per_call - 0.001) < 0.0000001) ok("hard: cost/call=0.001");
  else fail("hard cost/call", String(hard.cost_usd_per_call));

  // Aggregate totals.
  if (report.totals.calls === 150) ok("totals.calls=150");
  else fail("totals.calls", String(report.totals.calls));
  if (report.totals.ok_calls === 130) ok("totals.ok_calls=130 (80 + 50)");
  else fail("totals.ok_calls", String(report.totals.ok_calls));
  // 100 × 0.0001 + 50 × 0.001 = 0.01 + 0.05 = 0.06.
  if (Math.abs(report.totals.total_cost_usd - 0.06) < 0.0001) ok("totals.cost=$0.06");
  else fail("totals.cost", String(report.totals.total_cost_usd));
}

// ─── Section 4: confidence mean ───────────────────────────────────────────

console.log("\nSection 4: confidence mean");

{
  const report = tuneRouter(router, spans);
  const easy = report.tiers.find(t => t.tier === "easy")!;
  // 80 × 0.9 + 20 × 0.5 = 72 + 10 = 82, / 100 = 0.82.
  if (Math.abs(easy.confidence_mean - 0.82) < 0.001) ok("easy: confidence_mean=0.82");
  else fail("easy confidence", String(easy.confidence_mean));
  const hard = report.tiers.find(t => t.tier === "hard")!;
  if (Math.abs(hard.confidence_mean - 0.95) < 0.001) ok("hard: confidence_mean=0.95");
  else fail("hard confidence", String(hard.confidence_mean));
}

// ─── Section 5: constraint evaluation ─────────────────────────────────────

console.log("\nSection 5: constraint evaluation");

{
  const report = tuneRouter(router, spans);
  if (report.constraints.length === 2) ok("2 constraints evaluated");
  else fail("constraints len", String(report.constraints.length));

  const passRate = report.constraints.find(c => c.metric === "validation_pass_rate")!;
  if (passRate && passRate.op === ">=" && passRate.threshold === 0.9) ok("constraint: validation_pass_rate >= 0.9 parsed");
  else fail("pass rate constraint", JSON.stringify(passRate));
  // Easy tier (0.8) fails, hard tier (1.0) passes.
  const easyObs = passRate.observed.find(o => o.tier === "easy")!;
  const hardObs = passRate.observed.find(o => o.tier === "hard")!;
  if (!easyObs.passes && hardObs.passes) ok("pass_rate: easy fails, hard passes");
  else fail("pass rate observed", JSON.stringify({ easy: easyObs, hard: hardObs }));

  const latency = report.constraints.find(c => c.metric === "latency_p95_ms")!;
  if (latency && latency.op === "<=" && latency.threshold === 30000) ok("constraint: latency_p95_ms <= 30000 parsed");
  else fail("latency constraint", JSON.stringify(latency));
  // Both tiers pass (easy: 195ms, hard: 5470ms).
  const allPassLatency = latency.observed.every(o => o.passes);
  if (allPassLatency) ok("latency: both tiers pass");
  else fail("latency observed", JSON.stringify(latency.observed));
}

// ─── Section 6: suggestions ────────────────────────────────────────────────

console.log("\nSection 6: suggestions");

{
  const report = tuneRouter(router, spans);
  // Pattern 2: easy fails pass_rate while hard passes → suggest lowering hard's max.
  // But hard has no max (default tier), so the suggestion looks for a tier
  // with a higher max. easy has max=0.6, hard has max=null (= Infinity).
  // Suggestion fires.
  if (report.suggestions.some(s => s.includes("easy") && s.includes("hard"))) {
    ok("suggestion: surfaces easy-fails-but-hard-passes pattern");
  } else {
    fail("pattern 2", JSON.stringify(report.suggestions));
  }
}

// Pattern 1: low call volume.
{
  const lowVolSpans: TraceSpanLike[] = [];
  for (let i = 0; i < 5; i++) lowVolSpans.push(makeSpan(i, "easy", "validate_failed", 100, 0.0001, 200, 0.5));
  const report = tuneRouter(router, lowVolSpans);
  if (report.suggestions.some(s => s.includes("Collect more traces"))) {
    ok("suggestion: low volume → collect more traces");
  } else {
    fail("pattern 1", JSON.stringify(report.suggestions));
  }
}

// Pattern 3: cheap tier passes everything → suggest raising max.
{
  const cheapSpans: TraceSpanLike[] = [];
  // 60 ok calls on the cheap tier (easy), 0 on hard.
  for (let i = 0; i < 60; i++) cheapSpans.push(makeSpan(i, "easy", "ok", 100, 0.0001, 200, 0.95));
  const report = tuneRouter(router, cheapSpans);
  if (report.suggestions.some(s => s.includes("raising max"))) {
    ok("suggestion: cheap tier passes everything → raising max");
  } else {
    fail("pattern 3", JSON.stringify(report.suggestions));
  }
}

// ─── Section 7: format report ─────────────────────────────────────────────

console.log("\nSection 7: formatTuneReport");

{
  const report = tuneRouter(router, spans);
  const out = formatTuneReport(report);
  if (out.includes("Router tune report: smart_router")) ok("format: header");
  else fail("header", out.slice(0, 100));
  if (out.includes("Per-tier metrics:")) ok("format: per-tier section");
  else fail("per-tier", "missing");
  if (out.includes("Policy constraints:")) ok("format: constraints section");
  else fail("constraints section", "missing");
  if (out.includes("Suggestions:")) ok("format: suggestions section");
  else fail("suggestions section", "missing");
  // Constraint result symbols.
  if (out.includes("v hard:") || out.includes("x easy:")) ok("format: per-tier check symbols");
  else fail("symbols", "no v/x present");
}

// ─── Section 8: determinism ───────────────────────────────────────────────

console.log("\nSection 8: determinism");

{
  const a = JSON.stringify(tuneRouter(router, spans));
  const b = JSON.stringify(tuneRouter(router, spans));
  if (a === b) ok("tuneRouter: deterministic across two runs");
  else fail("determinism", "differ");
}

// ─── Section 9: empty trace ───────────────────────────────────────────────

console.log("\nSection 9: empty trace");

{
  const report = tuneRouter(router, []);
  if (report.prompt_call_spans === 0) ok("empty: 0 prompt_call spans");
  else fail("empty count", String(report.prompt_call_spans));
  // Tiers still listed (declared in spec) but with 0 calls.
  if (report.tiers.length === router.tiers.length) ok("empty: tiers list still in declaration order");
  else fail("empty tiers", String(report.tiers.length));
  // All NaN in the per-tier metrics.
  for (const t of report.tiers) {
    if (t.calls === 0 && Number.isNaN(t.validation_pass_rate)) {
      // Expected.
    } else {
      fail("empty tier metrics", JSON.stringify(t));
      break;
    }
  }
  ok("empty: tier metrics report 0/NaN cleanly");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 19 v2 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
