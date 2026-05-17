/**
 * MarrowScript Cognition Emitter Tests — Phase 2
 *
 * Verifies that the cognition emitter produces the right shape of files for
 * a representative .marrow source. We focus on the emitted file set, the
 * surface of each file, and structural properties that downstream phases
 * (validation, observability) will rely on.
 *
 * This test does NOT spin up a live model server — it asserts on the shape
 * of generated TypeScript only. End-to-end runtime testing happens in the
 * project's own test harness once the emitted code is written to disk.
 *
 * Style follows compiler/src/test_react.ts and compiler/src/test_typechecker.ts.
 */

import { Lexer } from "../lexer";
import { Parser } from "../parser";
import { Lowering } from "../lowering";
import { TypeChecker } from "../typechecker";
import { emitProviders, collectUsedProviders } from "../emit_provider";
import { emitCognitionFiles, collectPromptTemplateExtensionPoints } from "../emit_cognition";
import { CATALOG, listCognitionPrimitives } from "../cognition_catalog";

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
    throw new Error(`type check failed: ${errs.map(e => `${e.code}:${e.message}`).join("; ")}`);
  }
  return new Lowering().lower(ast, "phase2-test")[0];
}

console.log("MarrowScript Cognition Emitter Tests — Phase 2\n");

// ─── Section 1: Catalog ─────────────────────────────────────────────────────

console.log("Section 1: Cognition catalog has the documented v1 primitives");
{
  // The catalog grew from 12 v1 primitives to 13 with Phase 9's
  // ingest_repository. listCognitionPrimitives sorts alphabetically.
  const expected = [
    "argmax_score",
    "compress_context",
    "consensus_check",
    "decompose_task",
    "escalate_model",
    "ingest_repository",
    "judge_pairwise",
    "repair_with_diff",
    "route_by_complexity",
    "self_critique",
    "semantic_slice",
    "tool_select",
    "vote",
  ];
  const actual = listCognitionPrimitives();
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    ok(`all ${expected.length} primitives present and sorted`);
  } else {
    fail("catalog list", `actual=${JSON.stringify(actual)}`);
  }

  // Spot-check a couple of catalog entries for shape.
  const cc = CATALOG.compress_context;
  if (cc && cc.category === "memory" && cc.callsModel === true && cc.cost === "small") {
    ok("compress_context: memory / callsModel / cost");
  } else {
    fail("compress_context shape", JSON.stringify({ category: cc?.category, calls: cc?.callsModel, cost: cc?.cost }));
  }
  const v = CATALOG.vote;
  if (v && v.callsModel === false && v.cost === "free") ok("vote: pure (no model, free)");
  else fail("vote shape", "vote should be model-free and cost=free");

  const aa = CATALOG.argmax_score;
  if (aa && aa.callsModel === false) ok("argmax_score: pure deterministic");
  else fail("argmax_score", "should be deterministic");
}

// ─── Section 2: Provider emitter ────────────────────────────────────────────

console.log("\nSection 2: Provider emitter writes only adapters that are used");

const phase2System = compile(`
  system Phase2 {
    extension_point tmpl_classify(text: string) {
      returns: string
      stable: false
    }
    extension_point tmpl_summarize(body: string, max_tokens: uint) {
      returns: string
      stable: false
    }

    model OllamaTiny {
      provider: ollama
      name: "qwen2.5:1.5b"
      context_window: 32000
      max_output: 512
      cost_class: tiny
      latency_class: fast
    }

    model VllmMedium {
      provider: openai_compat
      endpoint: "http://localhost:8080/v1"
      name: "phi-3.5-mini"
      context_window: 128000
      max_output: 2048
      cost_class: small
      latency_class: medium
    }

    router cheapest {
      by: input.complexity
      tier short { max: 0.3 -> OllamaTiny }
      tier rest  { -> VllmMedium }
      on_low_confidence: escalate
      confidence_threshold: 0.65
      fallback: VllmMedium
    }

    capability noop_classify(text: string) {
      cognition: compress_context using {
        history: text,
        target_tokens: 256
      }
      returns: string
      sync: eventual
      idempotent: true
    }

    prompt classify(text: string) {
      model: OllamaTiny
      template: "extension_point:tmpl_classify"
      returns: string
      timeout: 5s
      validate: schema_only
      retry: { max_attempts: 2, backoff: fixed, interval: 200ms }
      tools: [noop_classify]
    }

    prompt summarize(body: string, max_tokens: uint) {
      router: cheapest
      template: "extension_point:tmpl_summarize"
      returns: string
      timeout: 30s
      validate: schema_only
      on_invalid: escalate
      retry: { max_attempts: 3, backoff: exponential, interval: 1s }
    }

    entity Doc { owns: [body: string] }
    capability summarise_doc(d: Doc) {
      cognition: compress_context using {
        history: d.body,
        target_tokens: 512,
        strategy: "summarize_oldest"
      }
      returns: string
      sync: eventual
    }

    policy harness {
      rate_limit: 60 per 1m
      audit: true
    }
  }
`);

{
  const used = collectUsedProviders(phase2System);
  if (used.has("ollama") && used.has("openai_compat") && !used.has("llamacpp") && !used.has("koboldcpp") && !used.has("http")) {
    ok("collectUsedProviders: only ollama + openai_compat used");
  } else {
    fail("used providers", `actual=${[...used].join(", ")}`);
  }

  const files = emitProviders(phase2System);
  const paths = files.map(f => f.path).sort();
  const expected = [
    "src/providers/index.ts",
    "src/providers/ollama.ts",
    "src/providers/openai_compat.ts",
    "src/providers/ssrf_guard.ts",
    "src/providers/types.ts",
  ].sort();
  if (JSON.stringify(paths) === JSON.stringify(expected)) {
    ok("emitProviders: emits exactly the 5 expected files (no llamacpp/koboldcpp/http)");
  } else {
    fail("provider files", `actual=${JSON.stringify(paths)}`);
  }

  const types = files.find(f => f.path === "src/providers/types.ts")!;
  if (types.content.includes("interface IModelProvider") &&
      types.content.includes("interface ChatRequest") &&
      types.content.includes("interface ChatResponse") &&
      types.content.includes("approxTokens")) {
    ok("types.ts exports IModelProvider, ChatRequest/Response, approxTokens");
  } else {
    fail("types.ts surface", "missing one of IModelProvider / ChatRequest / ChatResponse / approxTokens");
  }

  const ssrf = files.find(f => f.path === "src/providers/ssrf_guard.ts")!;
  if (ssrf.content.includes("LLM_ENDPOINT_ALLOWLIST") &&
      ssrf.content.includes("isLoopback") &&
      ssrf.content.includes("isRfc1918")) {
    ok("ssrf_guard.ts: has env allowlist + loopback + RFC1918 check");
  } else {
    fail("ssrf_guard surface", "missing allowlist or host filters");
  }

  const ollama = files.find(f => f.path === "src/providers/ollama.ts")!;
  if (ollama.content.includes("OLLAMA_HOST") &&
      ollama.content.includes("/api/chat") &&
      ollama.content.includes("signal?: AbortSignal")) {
    ok("ollama.ts: hits /api/chat, honors AbortSignal, reads OLLAMA_HOST");
  } else {
    fail("ollama surface", "missing /api/chat or AbortSignal");
  }

  const openai = files.find(f => f.path === "src/providers/openai_compat.ts")!;
  if (openai.content.includes("/chat/completions") &&
      openai.content.includes("response_format") &&
      openai.content.includes("assertEndpointAllowed")) {
    ok("openai_compat.ts: hits /chat/completions, supports json mode, uses ssrf guard");
  } else {
    fail("openai_compat surface", "missing /chat/completions or json mode or ssrf guard");
  }

  const registry = files.find(f => f.path === "src/providers/index.ts")!;
  // Models must be sorted by name in the registry literal for determinism.
  const ollamaIdx = registry.content.indexOf("\"OllamaTiny\"");
  const vllmIdx = registry.content.indexOf("\"VllmMedium\"");
  if (ollamaIdx >= 0 && vllmIdx >= 0 && ollamaIdx < vllmIdx) {
    ok("provider registry: models sorted alphabetically");
  } else {
    fail("registry order", `OllamaTiny at ${ollamaIdx}, VllmMedium at ${vllmIdx}`);
  }
  if (registry.content.includes("new OllamaProvider()") &&
      registry.content.includes("new OpenAICompatProvider(\"http://localhost:8080/v1\")")) {
    ok("provider registry: instantiates with declared endpoint args");
  } else {
    fail("registry constructors", "missing OllamaProvider() or OpenAICompatProvider(...)");
  }
}

// ─── Section 3: Cognition emitter — file set & shape ────────────────────────

console.log("\nSection 3: emitCognitionFiles produces the documented tree");

{
  const files = emitCognitionFiles(phase2System);
  const paths = files.map(f => f.path).sort();
  const expected = [
    "src/cognition/index.ts",
    "src/cognition/primitives.ts",
    "src/cognition/prompts.ts",
    "src/cognition/router.ts",
  ];
  if (JSON.stringify(paths) === JSON.stringify(expected)) {
    ok("emits exactly router + prompts + primitives + index");
  } else {
    fail("cognition files", `actual=${JSON.stringify(paths)}`);
  }

  const router = files.find(f => f.path === "src/cognition/router.ts")!;
  if (router.content.includes("ROUTER_cheapest") &&
      router.content.includes("if (!Number.isNaN(value) && value <= 0.3)") &&
      router.content.includes("escalate(currentTier")) {
    ok("router.ts: tier ladder compiled with explicit threshold + escalate");
  } else {
    fail("router compilation", "missing tier compile or escalate");
  }

  const prompts = files.find(f => f.path === "src/cognition/prompts.ts")!;
  if (prompts.content.includes("async function prompt_classify(") &&
      prompts.content.includes("async function prompt_summarize(")) {
    ok("prompts.ts: one async fn per declared prompt");
  } else {
    fail("prompt callers", "missing prompt_classify or prompt_summarize");
  }
  if (prompts.content.includes("__maxAttempts = 2") &&
      prompts.content.includes("__maxAttempts = 3")) {
    ok("prompts.ts: max_attempts compiled per-prompt");
  } else {
    fail("retry policy", "max_attempts not embedded");
  }
  if (prompts.content.includes("setTimeout(() => __controller.abort(), 5000)")) {
    ok("prompts.ts: 5s timeout compiled into AbortController");
  } else {
    fail("timeout", "5000ms not found");
  }
  if (prompts.content.includes("// on_invalid: fail — bubble immediately") &&
      prompts.content.includes("// on_invalid: escalate")) {
    ok("prompts.ts: on_invalid actions compiled (fail default + escalate)");
  } else {
    fail("on_invalid", "missing one of fail/escalate branches");
  }
  if (prompts.content.includes("__router.escalate(__tier)")) {
    ok("prompts.ts: router-escalate path compiled when prompt uses a router");
  } else {
    fail("escalate path", "router escalate call missing");
  }
  if (prompts.content.includes("loadExtension(\"tmpl_classify\")") &&
      prompts.content.includes("loadExtension(\"tmpl_summarize\")")) {
    ok("prompts.ts: extension_point templates loaded by name");
  } else {
    fail("template loading", "missing loadExtension calls");
  }
  if (prompts.content.includes("counter(\"cognition.prompt_calls\"") &&
      prompts.content.includes("histogram(\"cognition.prompt_latency_ms\"") &&
      prompts.content.includes("logger.info(\"cognition_prompt_ok\"") &&
      prompts.content.includes("logger.warn(\"cognition_prompt_failed\"")) {
    ok("prompts.ts: structured tracing wired (counter/histogram/logger)");
  } else {
    fail("tracing", "missing one of cognition.prompt_calls / latency / ok / failed");
  }
  if (prompts.content.includes("Math.pow(2, __attempt - 1)")) {
    ok("prompts.ts: exponential backoff compiled for summarize prompt");
  } else {
    fail("backoff", "exponential backoff not found");
  }

  const primitives = files.find(f => f.path === "src/cognition/primitives.ts")!;
  if (primitives.content.includes("async function compress_context") &&
      !primitives.content.includes("async function vote")) {
    ok("primitives.ts: only emits used primitives (compress_context, not vote)");
  } else {
    fail("primitive selection", "vote should NOT be emitted");
  }
  if (primitives.content.includes("PRIMITIVES: Record<string, CognitionPrimitive>") &&
      primitives.content.includes("\"compress_context\": compress_context")) {
    ok("primitives.ts: dispatch table populated");
  } else {
    fail("dispatch table", "PRIMITIVES record missing");
  }

  const index = files.find(f => f.path === "src/cognition/index.ts")!;
  if (index.content.includes("buildCtx") &&
      index.content.includes("callPrompt") &&
      index.content.includes("runCognition") &&
      index.content.includes("newTraceId")) {
    ok("index.ts: exports buildCtx, callPrompt, runCognition, newTraceId");
  } else {
    fail("index surface", "missing one of buildCtx/callPrompt/runCognition/newTraceId");
  }
}

// ─── Section 4: Determinism ─────────────────────────────────────────────────

console.log("\nSection 4: Cognition emitter is deterministic");

{
  const a = emitProviders(phase2System).map(f => f.content).join("---");
  const b = emitProviders(phase2System).map(f => f.content).join("---");
  if (a === b) ok("emitProviders: bitwise identical across two runs");
  else fail("provider determinism", "two runs differ");

  const c1 = emitCognitionFiles(phase2System).map(f => f.content).join("---");
  const c2 = emitCognitionFiles(phase2System).map(f => f.content).join("---");
  if (c1 === c2) ok("emitCognitionFiles: bitwise identical across two runs");
  else fail("cognition determinism", "two runs differ");
}

// ─── Section 5: Edge cases ──────────────────────────────────────────────────

console.log("\nSection 5: Edge cases");

{
  // No-cognition system → no files emitted.
  const nonCognition = compile(`
    system Plain {
      entity Thing { owns: [name: string] }
      capability rename(t: Thing, name: string) {
        requires: [name != ""]
        effects: [t.name = name]
        sync: eventual
      }
    }
  `);
  if (emitProviders(nonCognition).length === 0 &&
      emitCognitionFiles(nonCognition).length === 0) {
    ok("non-cognition system: zero new files");
  } else {
    fail("non-cognition", "expected 0 files");
  }

  // Single provider in use → only that adapter is emitted.
  const ollamaOnly = compile(`
    system Solo {
      extension_point tmpl(x: string) { returns: string, stable: false }
      model M {
        provider: ollama
        name: "x"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }
      prompt p(x: string) { model: M, template: "extension_point:tmpl", returns: string }
    }
  `);
  const usedSolo = collectUsedProviders(ollamaOnly);
  if (usedSolo.size === 1 && usedSolo.has("ollama")) ok("ollama-only system: only ollama used");
  else fail("ollama-only", `used=${[...usedSolo].join(", ")}`);
  const filesSolo = emitProviders(ollamaOnly);
  const hasOpenAI = filesSolo.some(f => f.path.includes("openai_compat"));
  if (!hasOpenAI) ok("ollama-only system: openai_compat.ts NOT emitted");
  else fail("ollama-only", "openai_compat.ts should not be emitted");

  // Prompt template references ALL extension_points used in templates / validate:custom
  const refs = collectPromptTemplateExtensionPoints(phase2System);
  if (refs.has("tmpl_classify") && refs.has("tmpl_summarize")) {
    ok("collectPromptTemplateExtensionPoints: collects template refs");
  } else {
    fail("ext refs", `actual=${[...refs].join(", ")}`);
  }
}

// ─── Section 6: T028 (cognition catalog membership) ─────────────────────────

console.log("\nSection 6: Type checker rejects unknown cognition primitives (T028)");

{
  const tokens = new Lexer(`
    system Bad {
      entity Doc { owns: [body: string] }
      capability bad(d: Doc) {
        cognition: not_a_real_primitive using { x: 1 }
        returns: string
        sync: eventual
      }
    }
  `).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  const t028 = errs.find(e => e.code === "T028");
  if (t028) ok("T028: capability uses unknown cognition primitive");
  else fail("T028", `expected T028, got [${errs.map(e => e.code).join(", ")}]`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Cognition Phase 2 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
