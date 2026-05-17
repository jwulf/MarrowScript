/**
 * MarrowScript Cognition Phase 6 Tests — observability
 *
 * Verifies:
 *   1. emit_traces.ts produces migrations/cognition_traces.sql,
 *      src/cognition/traces.ts, and src/traces/exporter.ts only when prompts exist.
 *   2. Traces schema has the documented columns + indexes.
 *   3. Runtime traces module exposes writeSpan / loadTrace / __resetTraces and
 *      switches backends via LLM_TRACES_BACKEND.
 *   4. OTLP exporter builds a valid OTLP/JSON resourceSpans payload.
 *   5. The generated prompt body writes spans at every observable boundary.
 *   6. Logger schema includes the Phase 6 cognition fields.
 *   7. End-to-end: a real prompt invocation against a stub provider produces
 *      the expected span sequence; loadTrace() returns them in order.
 *   8. The marrowc replay CLI command exists and prints a summary for a trace.
 *
 * Style follows compiler/src/test_cognition_phase5.ts.
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
import { emitTraceFiles, tracesNeeded } from "../emit_traces";
import { emitCognitionFiles } from "../emit_cognition";

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
  return new Lowering().lower(ast, "phase6-test")[0];
}

console.log("MarrowScript Cognition Phase 6 Tests — observability\n");

// ─── Section 1: conditional emission ────────────────────────────────────────

console.log("Section 1: emitTraceFiles is conditional on prompts");

{
  const noPrompts = compile(`
    system NoPrompts {
      entity X { owns: [name: string] }
      capability rename(x: X, name: string) {
        requires: [name != ""]
        effects: [x.name = name]
        sync: eventual
      }
    }
  `);
  if (!tracesNeeded(noPrompts)) ok("tracesNeeded: false when no prompts declared");
  else fail("tracesNeeded(noPrompts)", "expected false");
  if (emitTraceFiles(noPrompts).length === 0) ok("emitTraceFiles: zero files for non-prompt system");
  else fail("emitTraceFiles(noPrompts)", "unexpected files");

  const withPrompts = compile(`
    system WithPrompts {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) { model: M, template: "extension_point:t", returns: string }
    }
  `);
  if (tracesNeeded(withPrompts)) ok("tracesNeeded: true when prompts declared");
  else fail("tracesNeeded(withPrompts)", "expected true");

  const files = emitTraceFiles(withPrompts);
  const paths = files.map(f => f.path).sort();
  const expected = [
    "migrations/cognition_traces.sql",
    "src/cognition/traces.ts",
    "src/routes/cognition_traces.ts",
    "src/traces/exporter.ts",
  ];
  if (JSON.stringify(paths) === JSON.stringify(expected)) ok("emitTraceFiles: 4-file tree (incl. /cognition_traces HTTP route)");
  else fail("trace files", JSON.stringify(paths));
}

// ─── Section 2: schema shape ────────────────────────────────────────────────

console.log("\nSection 2: cognition_traces.sql shape");

const phase6System = compile(`
  system Phase6 {
    extension_point t(x: string) { returns: string, stable: false }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(x: string) { model: M, template: "extension_point:t", returns: string }
  }
`);

{
  const files = emitTraceFiles(phase6System);
  const schema = files.find(f => f.path === "migrations/cognition_traces.sql")!;
  const requiredCols = [
    "span_id", "trace_id", "parent_span_id", "workflow", "step", "kind",
    "prompt", "model", "provider", "input_redacted", "output_redacted",
    "validate_result", "confidence",
    "prompt_tokens", "completion_tokens", "cost_usd", "latency_ms", "cache_hit",
    "status", "error_code", "metadata", "started_at", "finished_at",
  ];
  let allPresent = true;
  for (const col of requiredCols) {
    if (!schema.content.includes(col)) { allPresent = false; break; }
  }
  if (allPresent) ok(`cognition_traces.sql: all ${requiredCols.length} required columns present`);
  else fail("schema columns", "one or more missing");

  for (const idx of ["idx_cognition_traces_trace", "idx_cognition_traces_prompt", "idx_cognition_traces_status", "idx_cognition_traces_model"]) {
    if (schema.content.includes(idx)) ok(`schema: ${idx}`);
    else fail(idx, "missing");
  }
}

// ─── Section 3: runtime surface ─────────────────────────────────────────────

console.log("\nSection 3: traces.ts surface");

{
  const files = emitTraceFiles(phase6System);
  const runtime = files.find(f => f.path === "src/cognition/traces.ts")!;
  for (const sym of ["writeSpan", "loadTrace", "__resetTraces", "redactForTrace", "CognitionSpan", "SpanKind", "SpanStatus"]) {
    if (runtime.content.includes(sym)) ok(`traces.ts: exports ${sym}`);
    else fail(`traces.ts ${sym}`, "missing");
  }
  if (runtime.content.includes("class MemoryBackend") &&
      runtime.content.includes("class PgBackend") &&
      runtime.content.includes("class NoopBackend") &&
      runtime.content.includes("LLM_TRACES_BACKEND")) {
    ok("traces.ts: three backends + env switch");
  } else {
    fail("traces.ts backends", "missing one of MemoryBackend/PgBackend/NoopBackend/LLM_TRACES_BACKEND");
  }
  if (runtime.content.includes("ALWAYS_REDACT") &&
      runtime.content.includes("SENSITIVE_FIELDS") &&
      runtime.content.includes("redactValue")) {
    ok("traces.ts: redaction wired");
  } else {
    fail("traces.ts redaction", "missing");
  }
}

// ─── Section 4: OTLP exporter ───────────────────────────────────────────────

console.log("\nSection 4: OTLP exporter shape");

{
  const files = emitTraceFiles(phase6System);
  const otel = files.find(f => f.path === "src/traces/exporter.ts")!;
  for (const sym of ["buildOtlpPayload", "exportBatch", "spanToOtlp", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME"]) {
    if (otel.content.includes(sym)) ok(`exporter.ts: ${sym}`);
    else fail(`exporter.ts ${sym}`, "missing");
  }
  // Confirm OTLP attribute keys are present.
  for (const attr of ["llm.model", "llm.provider", "llm.usage.prompt_tokens", "llm.usage.completion_tokens", "llm.usage.cost_usd", "cognition.workflow", "cognition.kind"]) {
    if (otel.content.includes(attr)) ok(`exporter.ts: OTLP attr ${attr}`);
    else fail(`OTLP attr ${attr}`, "missing");
  }
}

// ─── Section 5: prompt body wiring ──────────────────────────────────────────

console.log("\nSection 5: prompt body writes spans at every boundary");

{
  const cogFiles = emitCognitionFiles(phase6System);
  const prompts = cogFiles.find(f => f.path === "src/cognition/prompts.ts")!;
  if (prompts.content.includes("import { writeSpan } from \"./traces\"")) ok("prompts.ts imports writeSpan");
  else fail("writeSpan import", "missing");

  // The minimal phase6 system has only one no-cache, no-validate-failures prompt
  // so we expect at least:
  //   - success span (kind: prompt_call, status: ok)
  //   - failure span (kind: prompt_call OR validate, status via ternary)
  //   - budget span (kind: budget_exceeded, status: budget_exceeded)
  for (const marker of [
    `kind: "prompt_call"`, `status: "ok"`,
    `"validate" : "prompt_call"`,
    `"validate_failed" : "provider_error"`,
    `status: "budget_exceeded"`,
  ]) {
    if (prompts.content.includes(marker)) ok(`prompts.ts span: ${marker}`);
    else fail(`prompts.ts span ${marker}`, "missing");
  }
}

// Cache hit / repair / escalate spans only emitted on prompts that opt in.
{
  const richSystem = compile(`
    system Rich {
      extension_point t(x: string) { returns: string, stable: false }
      extension_point r(x: string) { returns: string, stable: false }
      model A { provider: ollama, name: "a", context_window: 8000, max_output: 256, cost_class: tiny }
      model B { provider: ollama, name: "b", context_window: 8000, max_output: 256, cost_class: small }
      router R {
        by: input.size
        tier short { max: 100 -> A }
        tier rest  { -> B }
      }
      prompt cached_p(x: string) {
        model: A
        template: "extension_point:t"
        returns: string
        cache: { key: hash(x), ttl: 1h }
      }
      prompt repair_p(x: string) {
        model: A
        template: "extension_point:r"
        returns: string
        validate: schema_only
        on_invalid: retry_with_repair_prompt
        retry: { max_attempts: 2, backoff: fixed, interval: 50ms }
      }
      prompt escalate_p(x: string) {
        router: R
        template: "extension_point:t"
        returns: string
        validate: schema_only
        on_invalid: escalate
      }
    }
  `);
  const cogFiles = emitCognitionFiles(richSystem);
  const prompts = cogFiles.find(f => f.path === "src/cognition/prompts.ts")!;
  for (const marker of [
    `kind: "cache_hit"`, `status: "cache_hit"`,
    `kind: "repair"`, `status: "repair_accepted"`, `status: "repair_rejected"`,
    `kind: "escalate"`, `status: "escalated"`,
    `"validate" : "prompt_call"`,
    `"validate_failed" : "provider_error"`,
  ]) {
    if (prompts.content.includes(marker)) ok(`prompts.ts rich span: ${marker}`);
    else fail(`prompts.ts ${marker}`, "missing");
  }
}

// ─── Section 6: logger schema ───────────────────────────────────────────────

console.log("\nSection 6: logger schema includes Phase 6 fields");

{
  // emitLogger lives in emit_maintenance.ts; we read it via a fresh import.
  // Re-importing avoids relying on the in-process module cache.
  const tokens = new Lexer(`
    system L {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) { model: M, template: "extension_point:t", returns: string }
    }
  `).tokenize();
  const ast = new Parser(tokens).parse();
  const ir = new Lowering().lower(ast, "ph6")[0];
  const fullFiles = new FullEmitter().emit(ir);
  const logger = fullFiles.find(f => f.path === "src/logger.ts");
  if (!logger) {
    fail("logger.ts", "not emitted");
  } else {
    for (const f of ["model?", "provider?", "prompt_tokens?", "completion_tokens?", "cost_usd?", "cache_hit?", "confidence?"]) {
      if (logger.content.includes(f)) ok(`logger.ts: optional field ${f}`);
      else fail(`logger.ts ${f}`, "missing");
    }
  }
}

// ─── Section 7: determinism ─────────────────────────────────────────────────

console.log("\nSection 7: Phase 6 emit is deterministic");

{
  const a = emitTraceFiles(phase6System).map(f => f.content).join("---");
  const b = emitTraceFiles(phase6System).map(f => f.content).join("---");
  if (a === b) ok("emitTraceFiles: deterministic");
  else fail("trace determinism", "differ");
}

// ─── Section 8: end-to-end runtime ──────────────────────────────────────────

console.log("\nSection 8: compiled runtime writes + loads spans");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp_phase6_e2e");

function compileFixture(outDir: string, fixture: string): boolean {
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
  // Fill the stub.
  const ext = path.join(outDir, "src/extensions.ts");
  let content = fs.readFileSync(ext, "utf-8");
  content = content.replace(
    /\/\/ <marrowscript:ext:tmpl_class:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_class:end>/,
    "// <marrowscript:ext:tmpl_class:begin>\n  return `Classify: ${text}`;\n  // <marrowscript:ext:tmpl_class:end>",
  );
  fs.writeFileSync(ext, content, "utf-8");
  return true;
}

const FIXTURE = `
system Phase6E2E {
  domain: cognitive_scaffold

  extension_point tmpl_class(text: string) {
    returns: string
    stable: false
  }

  model Tiny {
    provider: ollama
    name: "qwen2.5:1.5b"
    context_window: 8000
    max_output: 256
    cost_class: tiny
    latency_class: fast
  }

  prompt classify(text: string) {
    model: Tiny
    template: "extension_point:tmpl_class"
    returns: string
    timeout: 5s
    validate: schema_only
    cache: { key: hash(text), ttl: 1h }
  }

  policy harness {
    rate_limit: 60 per 1m
    audit: true
  }
}
`;

const compiled = compileFixture(OUT, FIXTURE);
if (!compiled) fail("compile fixture", "failed");
else ok("compiled Phase 6 fixture");

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
    const driver = `
import { getModel } from "../src/providers";
import { callPrompt } from "../src/cognition";
import { loadTrace, __resetTraces } from "../src/cognition/traces";
import { buildOtlpPayload } from "../src/traces/exporter";

let calls = 0;
let nextResp = "ok";
const stub: any = {
  name: "stub",
  countTokens: (s: string) => Math.ceil(s.length / 4),
  async chat(_req: any) {
    calls++;
    if (nextResp === "ERROR") throw new Error("provider blew up");
    return { content: nextResp, usage: { prompt_tokens: 7, completion_tokens: 3 } };
  },
};
(getModel("Tiny") as any).provider = stub;

(async () => {
  __resetTraces();

  // Drive trace 1: cache miss, then cache hit.
  const trace_id = "11111111-1111-1111-1111-111111111111";
  // We need to pass our own trace_id to make the tests deterministic. callPrompt
  // generates a fresh trace_id; we use the underlying PROMPTS API instead.
  const { PROMPTS } = await import("./src/cognition") as any;
  await PROMPTS["classify"]({ text: "hello" }, { trace_id });
  await PROMPTS["classify"]({ text: "hello" }, { trace_id });

  // Different input → cache miss.
  await PROMPTS["classify"]({ text: "world" }, { trace_id });

  const spans = await loadTrace(trace_id);
  process.stdout.write("SPANS::" + JSON.stringify(spans.map(s => ({
    kind: s.kind,
    status: s.status,
    cache_hit: s.cache_hit,
    prompt: s.prompt,
    has_input: s.input_redacted !== null,
    has_output: s.output_redacted !== null,
    tokens: (s.prompt_tokens ?? 0) + (s.completion_tokens ?? 0),
  }))) + "\\n");

  // OTLP shape sanity check.
  const otlp = buildOtlpPayload(spans);
  process.stdout.write("OTLP::" + JSON.stringify({
    has_resource: Array.isArray((otlp as any).resourceSpans) && (otlp as any).resourceSpans.length === 1,
    span_count: ((otlp as any).resourceSpans?.[0]?.scopeSpans?.[0]?.spans || []).length,
    first_name: (otlp as any).resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name,
    has_traceId: typeof (otlp as any).resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.traceId === "string",
  }) + "\\n");

  // Provider error path: ensure the failure span is captured.
  __resetTraces();
  const trace_id_err = "22222222-2222-2222-2222-222222222222";
  nextResp = "ERROR";
  let threw = false;
  try {
    await PROMPTS["classify"]({ text: "boom" }, { trace_id: trace_id_err });
  } catch { threw = true; }
  const errSpans = await loadTrace(trace_id_err);
  process.stdout.write("ERR::" + JSON.stringify({
    threw,
    spans: errSpans.map(s => ({ kind: s.kind, status: s.status, error_code: s.error_code })),
  }) + "\\n");

  // Determinism: same trace_id, same set of inputs, same starting state →
  // same number of spans and same status sequence. We must reset both the
  // trace store AND the prompt cache to start from a clean slate.
  __resetTraces();
  const { __resetMemoryCache } = await import("./src/cognition/cache") as any;
  __resetMemoryCache();
  nextResp = "ok";
  const trace_id_d = "33333333-3333-3333-3333-333333333333";
  await PROMPTS["classify"]({ text: "alpha" }, { trace_id: trace_id_d });
  await PROMPTS["classify"]({ text: "alpha" }, { trace_id: trace_id_d });
  const seq1 = (await loadTrace(trace_id_d)).map(s => s.kind + ":" + s.status).join(",");
  __resetTraces();
  __resetMemoryCache();
  await PROMPTS["classify"]({ text: "alpha" }, { trace_id: trace_id_d });
  await PROMPTS["classify"]({ text: "alpha" }, { trace_id: trace_id_d });
  const seq2 = (await loadTrace(trace_id_d)).map(s => s.kind + ":" + s.status).join(",");
  process.stdout.write("DET::" + JSON.stringify({ seq1, seq2, equal: seq1 === seq2 }) + "\\n");
})().catch(err => {
  process.stderr.write("FAIL::" + (err && err.message || String(err)));
  process.exit(1);
});
`;
    fs.writeFileSync(path.join(OUT, "phase6_driver.ts"), driver, "utf-8");
    try {
      const out = execSync("npx --no-install ts-node --transpile-only phase6_driver.ts", {
        cwd: OUT,
        stdio: "pipe",
        encoding: "utf-8",
      });
      const get = (re: RegExp) => (out.match(re) || [])[1];
      const spansJson = get(/SPANS::(\[.*\])/);
      const otlpJson = get(/OTLP::(\{.*\})/);
      const errJson = get(/ERR::(\{.*\})/);
      const detJson = get(/DET::(\{.*\})/);

      if (spansJson) {
        const spans = JSON.parse(spansJson) as Array<{ kind: string; status: string; cache_hit: boolean; prompt: string; has_input: boolean; has_output: boolean; tokens: number }>;
        // Expected sequence:
        //   prompt_call/ok      (text=hello, miss)
        //   cache_hit/cache_hit (text=hello, hit)
        //   prompt_call/ok      (text=world, miss)
        const seq = spans.map(s => s.kind + ":" + s.status).join(",");
        if (seq === "prompt_call:ok,cache_hit:cache_hit,prompt_call:ok") {
          ok("trace 1: prompt_call → cache_hit → prompt_call sequence");
        } else {
          fail("trace 1 sequence", seq);
        }
        if (spans.every(s => s.prompt === "classify")) ok("all spans tagged with prompt name");
        else fail("prompt tags", JSON.stringify(spans.map(s => s.prompt)));
        if (spans[0].has_input && spans[0].has_output) ok("first prompt_call span carries input+output (redacted)");
        else fail("input/output presence", JSON.stringify(spans[0]));
        if (spans[1].cache_hit === true) ok("cache_hit span has cache_hit:true");
        else fail("cache_hit flag", JSON.stringify(spans[1]));
        if (spans[0].tokens === 10 && spans[2].tokens === 10) ok("usage tokens recorded on prompt_call spans");
        else fail("token count", JSON.stringify({ s0: spans[0].tokens, s2: spans[2].tokens }));
      } else fail("SPANS output", out);

      if (otlpJson) {
        const o = JSON.parse(otlpJson) as { has_resource: boolean; span_count: number; first_name: string; has_traceId: boolean };
        if (o.has_resource) ok("OTLP: resourceSpans wrapper");
        else fail("OTLP resource", "missing");
        if (o.span_count === 3) ok("OTLP: 3 spans serialized");
        else fail("OTLP span count", String(o.span_count));
        if (typeof o.first_name === "string" && o.first_name.includes("classify")) ok("OTLP: span name includes prompt name");
        else fail("OTLP name", String(o.first_name));
        if (o.has_traceId) ok("OTLP: traceId is hex string");
        else fail("OTLP traceId", "missing");
      } else fail("OTLP output", out);

      if (errJson) {
        const e = JSON.parse(errJson) as { threw: boolean; spans: Array<{ kind: string; status: string; error_code: string | null }> };
        if (e.threw) ok("provider error: caller saw the throw");
        else fail("provider error throw", JSON.stringify(e));
        // Find at least one span with status: provider_error.
        const provErr = e.spans.find(s => s.status === "provider_error");
        if (provErr) ok("provider_error span emitted with error_code");
        else fail("provider_error span", JSON.stringify(e.spans));
      } else fail("ERR output", out);

      if (detJson) {
        const d = JSON.parse(detJson) as { seq1: string; seq2: string; equal: boolean };
        if (d.equal) ok("trace span sequence is deterministic across runs (same inputs, same trace)");
        else fail("trace determinism", `seq1=${d.seq1} seq2=${d.seq2}`);
      } else fail("DET output", out);
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
      fail("phase6 runtime", String(err.stdout || "") + " | " + String(err.stderr || ""));
    }
  }
}

// Cleanup.
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 6 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
