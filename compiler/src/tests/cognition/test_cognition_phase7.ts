/**
 * MarrowScript Cognition Phase 7 Tests — multi-model coordination
 *
 * Verifies the Phase 7 additions on top of the Phase 1-6 foundation:
 *   1. ChatResponse interface declares an optional `confidence` field.
 *   2. Provider adapters populate confidence where the wire format allows:
 *        - openai_compat: from logprobs.content (geometric mean of token probs)
 *        - llamacpp:      from completion_probabilities (mean of top-1 prob)
 *        - http:          pass-through of any `confidence` field on the body
 *        - ollama:        null (no logprobs in /api/chat response)
 *        - koboldcpp:     null (native API doesn't surface probabilities)
 *   3. SpanKind / SpanStatus include the new "low_confidence" entry.
 *   4. Cognition catalog ships the four aggregation primitives:
 *      vote, judge_pairwise, argmax_score, consensus_check.
 *   5. The generated prompts.ts wires a low-confidence check only when the
 *      prompt routes through a router with confidence_threshold > 0.
 *   6. End-to-end runtime:
 *      - vote: 3 candidates, majority winner returned with correct count
 *      - argmax_score: deterministic max selection with tie-breaking on first index
 *      - consensus_check: full agreement vs. partial disagreement disagreement_score
 *      - judge_pairwise: judge prompt picks "b" → caller receives candidate b
 *      - low_confidence: stub returns confidence=0.3, threshold=0.65,
 *        on_invalid: escalate → tier moves up; spans show
 *        low_confidence span followed by escalate, then a successful prompt_call
 *
 * Style follows compiler/src/test_cognition_phase6.ts.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";

import { Lexer } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";
import { ConstraintSolver } from "../solver";
import { FullEmitter } from "../emit_full";
import { emitProviders } from "../emit_provider";
import { emitCognitionFiles } from "../emit_cognition";
import { emitTraceFiles } from "../emit_traces";
import { CATALOG, lookupCognition, listCognitionPrimitives } from "../cognition_catalog";

let passed = 0;
let failed = 0;

function ok(name: string): void {
  console.log(`  v ${name}`);
  passed++;
}

function fail(name: string, msg: string): void {
  console.log(`  x ${name}: ${msg}`);
  failed++;
}

function compile(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) {
    throw new Error("type check failed: " + errs.map(e => e.code + ":" + e.message).join("; "));
  }
  return new Lowering().lower(ast, "phase7-test")[0];
}

console.log("MarrowScript Cognition Phase 7 Tests — multi-model coordination\n");

// ─── Section 1: ChatResponse + provider confidence wiring ────────────────────

console.log("Section 1: ChatResponse + provider confidence wiring");

{
  // We compile a single system that declares one model per provider so the
  // emitter writes every adapter file. Then we inspect each adapter for the
  // confidence-extraction pattern.
  const all = compile(`
    system AllProviders {
      extension_point t(x: string) { returns: string, stable: false }

      model M_ollama {
        provider: ollama
        name: "x"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }
      model M_oai {
        provider: openai_compat
        endpoint: "http://127.0.0.1:8080/v1"
        name: "x"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }
      model M_llamacpp {
        provider: llamacpp
        endpoint: "http://127.0.0.1:8081"
        name: "x"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }
      model M_kobold {
        provider: koboldcpp
        endpoint: "http://127.0.0.1:5001"
        name: "x"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }
      model M_http {
        provider: http
        endpoint: "http://127.0.0.1:9999"
        name: "x"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }

      prompt p(x: string) { model: M_ollama, template: "extension_point:t", returns: string }
    }
  `);
  const files = emitProviders(all);
  const byPath = new Map(files.map(f => [f.path, f.content]));

  const types = byPath.get("src/providers/types.ts") || "";
  if (types.includes("confidence?: number | null")) ok("ChatResponse: confidence?: number | null declared");
  else fail("ChatResponse confidence", "missing field on the response interface");

  const oai = byPath.get("src/providers/openai_compat.ts") || "";
  if (oai.includes("body.logprobs = true") && oai.includes("body.top_logprobs = 1")) ok("openai_compat: requests logprobs + top_logprobs");
  else fail("openai_compat logprobs request", "missing logprobs/top_logprobs request fields");
  if (oai.includes("openaiCompatConfidence")) ok("openai_compat: derives confidence from logprobs");
  else fail("openai_compat confidence helper", "missing openaiCompatConfidence");
  // Geometric mean — exp(mean(logprob)).
  if (oai.includes("Math.exp(mean)")) ok("openai_compat: confidence = exp(mean(logprob))");
  else fail("openai_compat confidence formula", "missing Math.exp(mean)");
  if (oai.includes("Math.max(0, Math.min(1, c))")) ok("openai_compat: confidence clamped to [0, 1]");
  else fail("openai_compat clamp", "missing clamp");

  const lc = byPath.get("src/providers/llamacpp.ts") || "";
  if (lc.includes("n_probs: 1")) ok("llamacpp: requests n_probs=1");
  else fail("llamacpp n_probs", "missing n_probs request field");
  if (lc.includes("llamaCppConfidence")) ok("llamacpp: derives confidence from completion_probabilities");
  else fail("llamacpp confidence helper", "missing llamaCppConfidence");

  const http = byPath.get("src/providers/http.ts") || "";
  if (http.includes("typeof data.confidence === \"number\" ? data.confidence : null")) ok("http: passes through response.confidence");
  else fail("http confidence pass-through", "missing");

  const oll = byPath.get("src/providers/ollama.ts") || "";
  if (!oll.includes("confidence")) ok("ollama: no confidence wiring (provider doesn't expose it)");
  else fail("ollama confidence", "should be absent");

  const kob = byPath.get("src/providers/koboldcpp.ts") || "";
  if (!kob.includes("confidence")) ok("koboldcpp: no confidence wiring (native API doesn't expose it)");
  else fail("koboldcpp confidence", "should be absent");
}

// ─── Section 2: SpanKind / SpanStatus include low_confidence ────────────────

console.log("\nSection 2: SpanKind / SpanStatus include low_confidence");

const phase7System = compile(`
  system Phase7 {
    extension_point tmpl(x: string) { returns: string, stable: false }
    extension_point judge(a: string, b: string, criteria: string) { returns: string, stable: false }

    model Tiny  { provider: ollama, name: "tiny",  context_window: 8000, max_output: 256, cost_class: tiny }
    model Small { provider: ollama, name: "small", context_window: 8000, max_output: 256, cost_class: small }

    router R {
      by: input.complexity
      tier short { max: 0.5 -> Tiny }
      tier rest  {           -> Small }
      on_low_confidence: escalate
      confidence_threshold: 0.65
    }

    // Prompt that routes through a router with a confidence threshold.
    prompt routed(x: string) {
      router: R
      template: "extension_point:tmpl"
      returns: string
      validate: schema_only
      on_invalid: escalate
      retry: { max_attempts: 2, backoff: fixed, interval: 50ms }
    }

    // Prompt without a router — no low-confidence wiring should be emitted.
    prompt direct(x: string) {
      model: Tiny
      template: "extension_point:tmpl"
      returns: string
    }

    // Judge prompt used by the runtime test for judge_pairwise.
    prompt judge_call(a: string, b: string, criteria: string) {
      model: Tiny
      template: "extension_point:judge"
      returns: string
    }
  }
`);

{
  const traceFiles = emitTraceFiles(phase7System);
  const runtime = traceFiles.find(f => f.path === "src/cognition/traces.ts")!;
  if (runtime.content.includes("\"low_confidence\"")) ok("traces.ts: SpanKind/SpanStatus include \"low_confidence\"");
  else fail("traces.ts low_confidence", "missing");
}

// ─── Section 3: cognition catalog ships aggregation primitives ──────────────

console.log("\nSection 3: cognition catalog has aggregation primitives");

{
  for (const name of ["vote", "judge_pairwise", "argmax_score", "consensus_check"]) {
    const spec = lookupCognition(name);
    if (spec) ok(`catalog: ${name} present (category=${spec.category}, callsModel=${spec.callsModel})`);
    else fail(`catalog ${name}`, "missing");
  }
  // vote / argmax_score / consensus_check must be free / no-model. judge_pairwise
  // is the only aggregation primitive that calls a model (it asks a judge).
  const vote = CATALOG.vote;
  if (vote && !vote.callsModel) ok("vote: callsModel=false (pure aggregation)");
  else fail("vote.callsModel", "should be false");
  const ax = CATALOG.argmax_score;
  if (ax && !ax.callsModel && ax.cost === "free") ok("argmax_score: cost=free, callsModel=false");
  else fail("argmax_score", JSON.stringify(ax));
  const cc = CATALOG.consensus_check;
  if (cc && !cc.callsModel && cc.cost === "free") ok("consensus_check: cost=free, callsModel=false");
  else fail("consensus_check", JSON.stringify(cc));
  const jp = CATALOG.judge_pairwise;
  if (jp && jp.callsModel) ok("judge_pairwise: callsModel=true (uses a judge prompt)");
  else fail("judge_pairwise.callsModel", "should be true");

  // listCognitionPrimitives must return a sorted list including all four.
  const sorted = listCognitionPrimitives();
  for (const expected of ["argmax_score", "consensus_check", "judge_pairwise", "vote"]) {
    if (sorted.includes(expected)) ok(`listCognitionPrimitives: contains ${expected}`);
    else fail(`listCognitionPrimitives ${expected}`, "missing");
  }
}

// ─── Section 4: prompt-body wiring for low-confidence ───────────────────────

console.log("\nSection 4: prompt body wires the low-confidence check only on routed prompts");

{
  const cogFiles = emitCognitionFiles(phase7System);
  const prompts = cogFiles.find(f => f.path === "src/cognition/prompts.ts")!;
  // The routed prompt must have the threshold comparison, the dedicated span,
  // and the __lowConfidence error marker.
  for (const marker of [
    "Phase 7: low-confidence check (router=R, threshold=0.65, on_low_confidence=escalate)",
    "if (__confidence !== null && __confidence < 0.65)",
    "kind: \"low_confidence\"",
    "status: \"low_confidence\"",
    "__lowConfidence",
    "cognition.low_confidence",
  ]) {
    if (prompts.content.includes(marker)) ok(`prompts.ts routed: ${marker.slice(0, 60)}`);
    else fail(`prompts.ts marker ${marker}`, "missing");
  }
  // The catch block recognizes __lowConfidence and skips the generic span emit
  // so traces don't double-count.
  if (prompts.content.includes("if (!__isLowConf)")) ok("prompts.ts: catch block skips generic span when __lowConfidence is set");
  else fail("isLowConf gate", "missing");

  // The non-routed prompt (`direct`) gets a confidence read but no threshold check.
  // We verify by looking for the comment that only appears on routed prompts.
  // The direct prompt block is identifiable by the `// Prompt: direct` comment.
  const directBlock = prompts.content.split("// Prompt: direct")[1] || "";
  const nextPrompt = directBlock.split("// Prompt:")[0] || directBlock;
  if (!nextPrompt.includes("Phase 7: low-confidence check")) ok("prompts.ts direct: no low-confidence threshold check");
  else fail("direct low-conf", "should not have threshold check");
  // It still records confidence for the success span.
  if (nextPrompt.includes("typeof __resp.confidence === \"number\"")) ok("prompts.ts direct: still records confidence on success span");
  else fail("direct conf record", "missing");
}

// ─── Section 5: determinism ─────────────────────────────────────────────────

console.log("\nSection 5: Phase 7 emit is deterministic");

{
  const a = emitCognitionFiles(phase7System).map(f => f.content).join("---");
  const b = emitCognitionFiles(phase7System).map(f => f.content).join("---");
  if (a === b) ok("emitCognitionFiles: deterministic");
  else fail("cognition determinism", "differ");
  const pa = emitProviders(phase7System).map(f => f.content).join("---");
  const pb = emitProviders(phase7System).map(f => f.content).join("---");
  if (pa === pb) ok("emitProviders: deterministic");
  else fail("provider determinism", "differ");
}

// ─── Section 6: end-to-end runtime ──────────────────────────────────────────

console.log("\nSection 6: end-to-end runtime");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp_phase7_e2e");

function compileFixture(outDir: string, fixture: string, fillExt: (content: string) => string): boolean {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const tokens = new Lexer(fixture).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) {
    console.error("type errors:", errs);
    return false;
  }
  const sourceHash = createHash("sha256").update(fixture).digest("hex").slice(0, 16);
  const irSystems = new Lowering().lower(ast, sourceHash);
  const solver = new ConstraintSolver();
  for (const sys of irSystems) {
    const r = solver.solve(sys);
    sys.resolution = r.resolution;
  }
  const files = new FullEmitter().emit(irSystems[0]);
  for (const f of files) {
    const full = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, "utf-8");
  }
  // Fill the extension stubs.
  const ext = path.join(outDir, "src/extensions.ts");
  if (fs.existsSync(ext)) {
    let content = fs.readFileSync(ext, "utf-8");
    content = fillExt(content);
    fs.writeFileSync(ext, content, "utf-8");
  }
  return true;
}

// Fixture: a router with an explicit threshold + escalate, plus a judge prompt
// for the judge_pairwise primitive end-to-end test. The escalate path moves
// from Tiny → Small; both go through the same stub provider, the stub picks
// what to return based on the model name passed in __req.model.
//
// The four aggregation primitives are wired in via capabilities (each takes
// the Sample entity to satisfy the lowering's entity-anchor convention) so
// they get emitted into src/cognition/primitives.ts and exposed via
// runCognition. The binding values are placeholders — at runtime we call the
// primitives directly with our test arguments.
const FIXTURE = `
system Phase7E2E {
  domain: cognitive_scaffold

  entity Sample {
    owns: [
      label: string
    ]
  }

  extension_point tmpl_class(text: string) {
    returns: string
    stable: false
  }
  extension_point tmpl_judge(a: string, b: string, criteria: string) {
    returns: string
    stable: false
  }

  model Tiny {
    provider: ollama
    name: "tiny-model"
    context_window: 8000
    max_output: 256
    cost_class: tiny
    latency_class: fast
  }
  model Small {
    provider: ollama
    name: "small-model"
    context_window: 8000
    max_output: 256
    cost_class: small
    latency_class: medium
  }

  router R {
    by: input.complexity
    tier low  { max: 0.5 -> Tiny }
    tier high {           -> Small }
    on_low_confidence: escalate
    confidence_threshold: 0.65
  }

  prompt classify(text: string, complexity: float) {
    router: R
    template: "extension_point:tmpl_class"
    returns: string
    validate: schema_only
    on_invalid: escalate
    retry: { max_attempts: 3, backoff: fixed, interval: 10ms }
  }

  prompt judge(a: string, b: string, criteria: string) {
    model: Tiny
    template: "extension_point:tmpl_judge"
    returns: string
  }

  // Capabilities reference each aggregation primitive so primitives.ts is
  // emitted with all four. The Sample entity parameter anchors them in the
  // lowering's entity-derived module. Binding values are required for the
  // parser but the test driver calls runCognition() directly with its own args.
  capability run_vote(s: Sample) {
    cognition: vote using {
      candidates: s.label
    }
    returns: string
    sync: eventual
  }

  capability run_judge(s: Sample) {
    cognition: judge_pairwise using {
      a: s.label,
      b: s.label,
      criteria: s.label,
      judge_prompt: "judge"
    }
    returns: string
    sync: eventual
  }

  capability run_argmax(s: Sample) {
    cognition: argmax_score using {
      items: s.label
    }
    returns: string
    sync: eventual
  }

  capability run_consensus(s: Sample) {
    cognition: consensus_check using {
      results: s.label
    }
    returns: bool
    sync: eventual
  }

  policy harness {
    rate_limit: 60 per 1m
    audit: true
  }
}
`;

const compiled = compileFixture(OUT, FIXTURE, (content) => {
  let c = content;
  c = c.replace(
    /\/\/ <marrowscript:ext:tmpl_class:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_class:end>/,
    "// <marrowscript:ext:tmpl_class:begin>\n  return `Classify: ${text}`;\n  // <marrowscript:ext:tmpl_class:end>",
  );
  c = c.replace(
    /\/\/ <marrowscript:ext:tmpl_judge:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_judge:end>/,
    "// <marrowscript:ext:tmpl_judge:begin>\n  return `${a} vs ${b}: ${criteria}`;\n  // <marrowscript:ext:tmpl_judge:end>",
  );
  return c;
});

if (!compiled) fail("compile fixture", "failed");
else ok("compiled Phase 7 fixture");

if (compiled) {
  const nm = path.join(OUT, "node_modules");
  if (!fs.existsSync(nm)) {
    console.log("  (installing project deps — first run only)");
    try {
      execSync("npm install --no-audit --no-fund --silent", { cwd: OUT, stdio: "pipe" });
    } catch {
      console.log("  (npm install failed — skipping runtime tests)");
    }
  }

  if (fs.existsSync(nm)) {
    // Driver that exercises:
    //   1. vote: pure primitive with 3 candidates
    //   2. argmax_score: pure primitive
    //   3. consensus_check: pure primitive (full + partial agreement)
    //   4. judge_pairwise: judge prompt → "b"
    //   5. low_confidence: stub returns confidence=0.3 first, then 0.95 after
    //      the prompt body escalates to Small. Inspect spans for the sequence.
    const driver = `
import { getModel } from "../src/providers";
import { runCognition } from "../src/cognition";
import { __resetTraces, loadTrace } from "../src/cognition/traces";

const tinyStub: any = {
  name: "stub-tiny",
  countTokens: (s: string) => Math.ceil(s.length / 4),
  async chat(req: any) {
    // The stub uses the model name on the request to decide what to return.
    if (req.model === "tiny-model") {
      // Low confidence on Tiny so the router escalates.
      return { content: "low-conf-output", usage: { prompt_tokens: 5, completion_tokens: 3 }, confidence: 0.3 };
    }
    if (req.model === "small-model") {
      // High confidence on Small.
      return { content: "high-conf-output", usage: { prompt_tokens: 6, completion_tokens: 4 }, confidence: 0.95 };
    }
    return { content: "fallback", usage: { prompt_tokens: 1, completion_tokens: 1 }, confidence: 0.99 };
  },
};
const judgeStub: any = {
  name: "stub-judge",
  countTokens: (s: string) => Math.ceil(s.length / 4),
  async chat(_req: any) {
    return { content: "b", usage: { prompt_tokens: 4, completion_tokens: 1 } };
  },
};

(getModel("Tiny") as any).provider = tinyStub;
(getModel("Small") as any).provider = tinyStub;

(async () => {
  // ── 1. vote ─────────────────────────────────────────────────────────────
  const v = await runCognition("vote", { candidates: ["a", "b", "a"] });
  process.stdout.write("VOTE::" + JSON.stringify(v) + "\\n");

  // Edge: empty list.
  const v2 = await runCognition("vote", { candidates: [] });
  process.stdout.write("VOTE_EMPTY::" + JSON.stringify(v2) + "\\n");

  // Edge: tie — first occurrence wins (deterministic).
  const v3 = await runCognition("vote", { candidates: ["x", "y", "z", "x", "y"] });
  process.stdout.write("VOTE_TIE::" + JSON.stringify(v3) + "\\n");

  // ── 2. argmax_score ─────────────────────────────────────────────────────
  const a = await runCognition("argmax_score", {
    items: [
      { value: "first",  score: 0.4 },
      { value: "best",   score: 0.9 },
      { value: "middle", score: 0.6 },
    ],
  });
  process.stdout.write("ARGMAX::" + JSON.stringify(a) + "\\n");

  // Edge: tie — earliest index wins.
  const a2 = await runCognition("argmax_score", {
    items: [
      { value: "alpha", score: 0.7 },
      { value: "beta",  score: 0.7 },
      { value: "gamma", score: 0.5 },
    ],
  });
  process.stdout.write("ARGMAX_TIE::" + JSON.stringify(a2) + "\\n");

  // Edge: empty list.
  const a3 = await runCognition("argmax_score", { items: [] });
  process.stdout.write("ARGMAX_EMPTY::" + JSON.stringify(a3) + "\\n");

  // ── 3. consensus_check ─────────────────────────────────────────────────
  const c1 = await runCognition("consensus_check", { results: ["x", "x", "x"] });
  process.stdout.write("CONS_AGREE::" + JSON.stringify(c1) + "\\n");

  const c2 = await runCognition("consensus_check", { results: ["x", "x", "y"] });
  process.stdout.write("CONS_PARTIAL::" + JSON.stringify(c2) + "\\n");

  const c3 = await runCognition("consensus_check", { results: ["x"] });
  process.stdout.write("CONS_SINGLE::" + JSON.stringify(c3) + "\\n");

  // ── 4. judge_pairwise ──────────────────────────────────────────────────
  // Swap the judge prompt's model to the judge stub so it returns "b".
  (getModel("Tiny") as any).provider = judgeStub;
  const j = await runCognition("judge_pairwise", {
    a: { id: 1, text: "alpha" },
    b: { id: 2, text: "beta"  },
    criteria: "clarity",
    judge_prompt: "judge",
  });
  process.stdout.write("JUDGE::" + JSON.stringify(j) + "\\n");

  // ── 5. low_confidence escalation ────────────────────────────────────────
  // Reset stubs to the routing scenario.
  (getModel("Tiny")  as any).provider = tinyStub;
  (getModel("Small") as any).provider = tinyStub;

  __resetTraces();
  const trace_id = "77777777-7777-7777-7777-777777777777";
  const { PROMPTS } = await import("./src/cognition") as any;
  // input.complexity = 0.1 → router picks Tiny → stub returns confidence=0.3
  // → low-confidence threshold (0.65) breached → on_invalid: escalate →
  // tier moves to Small → stub returns confidence=0.95 → success.
  const result = await PROMPTS["classify"]({ text: "anything", complexity: 0.1 }, { trace_id });
  const spans = await loadTrace(trace_id);
  process.stdout.write("LC::" + JSON.stringify({
    result,
    seq: spans.map(s => s.kind + ":" + s.status).join(","),
    confidences: spans.map(s => s.confidence),
    models: spans.map(s => s.model),
  }) + "\\n");
})().catch(err => {
  process.stderr.write("FAIL::" + (err && (err.stack || err.message) || String(err)));
  process.exit(1);
});
`;
    fs.writeFileSync(path.join(OUT, "phase7_driver.ts"), driver, "utf-8");
    try {
      const out = execSync("npx --no-install ts-node --transpile-only phase7_driver.ts", {
        cwd: OUT,
        stdio: "pipe",
        encoding: "utf-8",
      });
      const get = (re: RegExp) => (out.match(re) || [])[1];

      const vote = get(/VOTE::(\{.*\})/);
      const voteEmpty = get(/VOTE_EMPTY::(\{.*\})/);
      const voteTie = get(/VOTE_TIE::(\{.*\})/);
      const argmax = get(/ARGMAX::"?([^"\n]+)"?/);
      const argmaxTie = get(/ARGMAX_TIE::"?([^"\n]+)"?/);
      const argmaxEmpty = get(/ARGMAX_EMPTY::(\S+)/);
      const consAgree = get(/CONS_AGREE::(\{.*\})/);
      const consPartial = get(/CONS_PARTIAL::(\{.*\})/);
      const consSingle = get(/CONS_SINGLE::(\{.*\})/);
      const judge = get(/JUDGE::(\{.*\})/);
      const lc = get(/LC::(\{.*\})/);

      // ── vote ──
      if (vote) {
        const v = JSON.parse(vote);
        if (v.winner === "a" && v.count === 2 && v.total === 3) ok("vote: 3 candidates [a,b,a] → winner=a, count=2, total=3");
        else fail("vote", JSON.stringify(v));
      } else fail("VOTE output", out);

      if (voteEmpty) {
        const v = JSON.parse(voteEmpty);
        if (v.winner === null && v.count === 0 && v.total === 0) ok("vote: empty list → winner=null");
        else fail("vote empty", JSON.stringify(v));
      } else fail("VOTE_EMPTY output", out);

      if (voteTie) {
        const v = JSON.parse(voteTie);
        // ["x","y","z","x","y"]: x and y both have count 2, x appears first.
        if (v.winner === "x" && v.count === 2 && v.total === 5) ok("vote: tie [x,y,z,x,y] → x wins (earliest)");
        else fail("vote tie", JSON.stringify(v));
      } else fail("VOTE_TIE output", out);

      // ── argmax_score ──
      if (argmax) {
        if (argmax === "best") ok("argmax_score: scores [0.4,0.9,0.6] → best");
        else fail("argmax", argmax);
      } else fail("ARGMAX output", out);

      if (argmaxTie) {
        if (argmaxTie === "alpha") ok("argmax_score: tie [0.7,0.7,0.5] → alpha (earliest)");
        else fail("argmax tie", argmaxTie);
      } else fail("ARGMAX_TIE output", out);

      if (argmaxEmpty) {
        if (argmaxEmpty === "null") ok("argmax_score: empty list → null");
        else fail("argmax empty", argmaxEmpty);
      } else fail("ARGMAX_EMPTY output", out);

      // ── consensus_check ──
      if (consAgree) {
        const c = JSON.parse(consAgree);
        if (c.agree === true && c.disagreement_score === 0) ok("consensus_check: all match → agree=true, score=0");
        else fail("consensus agree", JSON.stringify(c));
      } else fail("CONS_AGREE output", out);

      if (consPartial) {
        const c = JSON.parse(consPartial);
        // Top has count 2 of 3 → score = 1 - 2/3 ≈ 0.3333.
        if (c.agree === false && Math.abs(c.disagreement_score - 0.3333) < 0.01) {
          ok("consensus_check: 2/3 match → agree=false, score≈0.333");
        } else fail("consensus partial", JSON.stringify(c));
      } else fail("CONS_PARTIAL output", out);

      if (consSingle) {
        const c = JSON.parse(consSingle);
        // List of 1 short-circuits to agree=true, score=0.
        if (c.agree === true && c.disagreement_score === 0) ok("consensus_check: single result → trivially agree");
        else fail("consensus single", JSON.stringify(c));
      } else fail("CONS_SINGLE output", out);

      // ── judge_pairwise ──
      if (judge) {
        const j = JSON.parse(judge);
        // Stub returns "b", so the primitive should return { winner: "b", value: <b> }.
        if (j.winner === "b" && j.value && j.value.id === 2 && j.value.text === "beta") {
          ok("judge_pairwise: judge picks b → returns candidate b");
        } else fail("judge_pairwise", JSON.stringify(j));
      } else fail("JUDGE output", out);

      // ── low-confidence escalation ──
      if (lc) {
        const r = JSON.parse(lc);
        // Expected sequence:
        //   1. low_confidence span (Tiny, conf 0.3, status low_confidence)
        //   2. escalate span (Small, status escalated)
        //   3. prompt_call span (Small, conf 0.95, status ok)
        // Generic catch span is suppressed because __isLowConf is true.
        const seq = r.seq;
        if (seq === "low_confidence:low_confidence,escalate:escalated,prompt_call:ok") {
          ok("low-confidence routing: low_confidence → escalate → prompt_call:ok");
        } else fail("LC span sequence", seq);

        if (Array.isArray(r.confidences) && r.confidences[0] === 0.3 && r.confidences[2] === 0.95) {
          ok("low-confidence routing: spans carry the recorded confidence values");
        } else fail("LC confidences", JSON.stringify(r.confidences));

        if (Array.isArray(r.models) && r.models[0] === "Tiny" && r.models[1] === "Small" && r.models[2] === "Small") {
          ok("low-confidence routing: model transitions Tiny → Small");
        } else fail("LC model transition", JSON.stringify(r.models));

        if (r.result === "high-conf-output") ok("low-confidence routing: caller receives the post-escalation output");
        else fail("LC result", String(r.result));
      } else fail("LC output", out);
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
      fail("phase7 runtime", String(err.stdout || "") + " | " + String(err.stderr || ""));
    }
  }
}

// Cleanup.
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 7 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
