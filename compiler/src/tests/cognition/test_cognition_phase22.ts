/**
 * MarrowScript Cognition Phase 22 Tests — replay-as-test
 *
 * Verifies:
 *   1. traceToTest produces a self-contained node:test file with the right
 *      imports, beforeEach/afterEach hooks, and per-prompt assertions.
 *   2. Recorded outputs are grouped per model and served FIFO. A trace with
 *      two prompts hitting the same model produces two queue entries.
 *   3. The emitted stub provider exhausts deterministically: a generated
 *      runner that's called more times than the trace recorded throws
 *      "exhausted" rather than silently re-using stale data.
 *   4. assertOutputs=false omits deep-equal assertions and keeps only the
 *      call-shape verification.
 *   5. Redacted outputs (containing "[REDACTED]") trigger a softer assertion
 *      that the call succeeded but doesn't compare the redacted value.
 *   6. Non-prompt_call spans (validate, repair, tool_call) are filtered out
 *      so the test doesn't try to drive them through callPrompt.
 *   7. The trace-level totals assertion pins call count, token count, and
 *      cost so future drift in instrumentation is visible at PR time.
 *   8. Determinism: traceToTest produces bitwise-identical output across
 *      two calls on the same input.
 */

import { traceToTest, type CognitionSpanLike } from "../trace_to_test";

let passed = 0;
let failed = 0;

function ok(name: string): void { console.log(`  v ${name}`); passed++; }
function fail(name: string, msg: string): void { console.log(`  x ${name}: ${msg}`); failed++; }

console.log("MarrowScript Cognition Phase 22 Tests — replay-as-test\n");

// ─── Sample trace fixture ───────────────────────────────────────────────────
//
// Two prompt_calls hitting the same model + one validate span (which should
// be filtered out). Mimics the shape the existing trace logger writes.

const sampleTrace: CognitionSpanLike[] = [
  {
    span_id: "s1",
    trace_id: "trace-abc",
    workflow: "classify",
    step: "chat",
    kind: "prompt_call",
    prompt: "classify",
    model: "Tiny",
    provider: "ollama",
    input_redacted: { text: "build an Adapter" },
    output_redacted: "component",
    prompt_tokens: 12,
    completion_tokens: 3,
    cost_usd: 0.0001,
    latency_ms: 250,
    cache_hit: false,
    status: "ok",
    started_at: 1_700_000_000_000,
    finished_at: 1_700_000_000_250,
  },
  {
    span_id: "s2",
    trace_id: "trace-abc",
    workflow: "classify",
    step: "validate",
    kind: "validate",
    prompt: "classify",
    model: "Tiny",
    provider: "ollama",
    status: "ok",
    started_at: 1_700_000_000_260,
    finished_at: 1_700_000_000_265,
    latency_ms: 5,
  },
  {
    span_id: "s3",
    trace_id: "trace-abc",
    workflow: "summarize",
    step: "chat",
    kind: "prompt_call",
    prompt: "summarize",
    model: "Tiny",
    provider: "ollama",
    input_redacted: { body: "lorem ipsum", max_tokens: 100 },
    output_redacted: "lorem.",
    prompt_tokens: 30,
    completion_tokens: 4,
    cost_usd: 0.0002,
    latency_ms: 400,
    cache_hit: false,
    status: "ok",
    started_at: 1_700_000_000_300,
    finished_at: 1_700_000_000_700,
  },
];

// ─── Section 1: file shape ──────────────────────────────────────────────────

console.log("Section 1: traceToTest produces a self-contained test file");

{
  const out = traceToTest(sampleTrace, { traceId: "trace-abc" });
  const required = [
    `import { test, beforeEach, afterEach } from "node:test"`,
    `import * as assert from "node:assert/strict"`,
    `import { callPrompt } from "../src/cognition"`,
    `import { getModel } from "../src/providers"`,
    `// Phase 22 — replay regression test for trace trace-abc.`,
    "function makeStubProvider(modelName: string) {",
    "beforeEach(() => {",
    "afterEach(() => {",
  ];
  for (const r of required) {
    if (out.includes(r)) ok(`emit: ${r.slice(0, 50)}…`);
    else fail(`missing ${r}`, "");
  }
}

// ─── Section 2: per-model FIFO queue ────────────────────────────────────────

console.log("\nSection 2: recorded outputs grouped per model FIFO");

{
  const out = traceToTest(sampleTrace, { traceId: "trace-abc" });
  // Two prompt_call spans on Tiny → two entries in __recorded["Tiny"].
  if (out.includes(`"Tiny": ["component","lorem."]`)) ok("Tiny queue: [component, lorem.] in order");
  else fail("Tiny queue", "expected [component, lorem.]");

  // Stub function exists and shifts the queue.
  if (out.includes("const queue = [...(__recorded[modelName] || [])];") &&
      out.includes("const out = queue.shift();")) {
    ok("stub: queue shifts FIFO");
  } else {
    fail("stub", "missing queue.shift()");
  }

  // Exhaustion error.
  if (out.includes(`replay stub for "\${modelName}" exhausted`)) {
    ok("stub: throws when called more times than recorded");
  } else {
    fail("stub exhaustion", "missing exhaustion error");
  }
}

// ─── Section 3: per-prompt assertions ──────────────────────────────────────

console.log("\nSection 3: per-prompt assertions");

{
  const out = traceToTest(sampleTrace, { traceId: "trace-abc" });

  if (out.includes(`callPrompt("classify", {"text":"build an Adapter"}`)) {
    ok("assertion 1: callPrompt(classify, {text})");
  } else {
    fail("call 1", "missing");
  }

  if (out.includes(`callPrompt("summarize", {"body":"lorem ipsum","max_tokens":100}`)) {
    ok("assertion 2: callPrompt(summarize, {body,max_tokens})");
  } else {
    fail("call 2", "missing");
  }

  if (out.includes(`assert.deepStrictEqual(result, __expected,`)) {
    ok("default: deepStrictEqual against recorded output");
  } else {
    fail("deepStrictEqual", "missing");
  }
}

// ─── Section 4: assertOutputs flag ─────────────────────────────────────────

console.log("\nSection 4: assertOutputs=false skips deep-equal");

{
  const out = traceToTest(sampleTrace, { traceId: "trace-abc", assertOutputs: false });
  if (!out.includes("assert.deepStrictEqual")) ok("no deepStrictEqual when assertOutputs=false");
  else fail("assertOutputs=false", "still contains deepStrictEqual");
  // ok-style check stays.
  if (out.includes("expected non-undefined result")) ok("still asserts result not undefined");
  else fail("call shape", "missing");
}

// ─── Section 5: redaction handling ─────────────────────────────────────────

console.log("\nSection 5: redacted outputs use a softer assertion");

{
  const trace: CognitionSpanLike[] = [
    {
      ...sampleTrace[0],
      output_redacted: "[REDACTED] sensitive data",
    },
  ];
  const out = traceToTest(trace, { traceId: "trace-redacted" });
  if (out.includes(`if (typeof __expected === "string" && __expected.includes("[REDACTED]"))`)) {
    ok("emit: redaction-aware branch present");
  } else {
    fail("redaction branch", "missing");
  }
}

// ─── Section 6: non-prompt_call spans filtered ─────────────────────────────

console.log("\nSection 6: non-prompt_call spans skipped");

{
  const out = traceToTest(sampleTrace, { traceId: "trace-abc" });
  // sample has 2 prompt_call spans + 1 validate. We expect exactly 2 callPrompt() invocations.
  const matches = out.match(/await callPrompt\(/g) ?? [];
  if (matches.length === 2) ok("emit: exactly 2 callPrompt() invocations (validate span filtered)");
  else fail("call count", `expected 2, got ${matches.length}`);
}

// ─── Section 7: trace-level totals ─────────────────────────────────────────

console.log("\nSection 7: trace-level totals pinned");

{
  const out = traceToTest(sampleTrace, { traceId: "trace-abc" });
  // 2 prompt calls, 12+3 + 30+4 = 49 tokens, 0.0001 + 0.0002 = 0.0003 USD.
  if (out.includes("recorded.calls, 2")) ok("totals: 2 calls");
  else fail("calls total", "missing");
  if (out.includes("recorded.tokens, 49")) ok("totals: 49 tokens");
  else fail("tokens total", "missing");
  if (out.includes("0.0003")) ok("totals: $0.0003 cost");
  else fail("cost total", "missing");
  if (out.includes("Math.abs(recorded.cost_usd - 0.0003) < 0.0001")) {
    ok("totals: cost asserted with tolerance");
  } else {
    fail("cost tolerance", "missing");
  }
}

// ─── Section 8: determinism ────────────────────────────────────────────────

console.log("\nSection 8: traceToTest is deterministic");

{
  const a = traceToTest(sampleTrace, { traceId: "trace-abc" });
  const b = traceToTest(sampleTrace, { traceId: "trace-abc" });
  if (a === b && a.length > 0) ok("traceToTest: bitwise identical across two calls");
  else fail("determinism", "differ");
}

// ─── Section 9: empty trace ─────────────────────────────────────────────────

console.log("\nSection 9: empty / non-prompt_call-only trace handled");

{
  const out = traceToTest([], { traceId: "empty" });
  if (out.includes(`"replay trace empty: 0 prompt call(s)"`)) ok("empty trace: 0-call test still emitted");
  else fail("empty trace", "no test emitted");
  // No callPrompt invocations.
  if (!out.includes("await callPrompt(")) ok("empty trace: no callPrompt() invocations");
  else fail("empty calls", "should be zero");
  if (out.includes("recorded.calls, 0")) ok("empty trace: totals pin 0 calls");
  else fail("empty totals", "missing");
}

// ─── Section 10: cognitionImportPath override ──────────────────────────────

console.log("\nSection 10: cognitionImportPath override threads to providers too");

{
  const out = traceToTest(sampleTrace, {
    traceId: "trace-abc",
    cognitionImportPath: "../../src/cognition",
  });
  if (out.includes(`from "../../src/cognition"`) && out.includes(`from "../../src/providers"`)) {
    ok("override: cognition + providers paths kept in lockstep");
  } else {
    fail("path override", "missing one of the paths");
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 22 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
