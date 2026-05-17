/**
 * MarrowScript Cognition Phase 15 Tests — bounded tool calls
 *
 * Verifies:
 *   1. T029 type check: a prompt's `tools:` entry must be a cognition-bearing
 *      capability (declared with `cognition: <primitive>`). Plain capabilities
 *      with `effects:` or `pipeline:` bodies are rejected.
 *   2. Lowering populates `IRSystem.tool_capabilities` from cognition-bearing
 *      capabilities referenced by any prompt's allowed_tools.
 *   3. ChatRequest / ChatResponse / ChatToolSpec / ChatToolCall are exported
 *      from the generated `src/providers/types.ts`.
 *   4. The OpenAI-compat adapter forwards `tools` and parses `tool_calls`.
 *   5. The cognition emitter generates a `__TOOL_SPECS` table with one
 *      entry per tool capability, sorted by name. Each entry has the right
 *      JSON Schema parameters built from the capability's IR fields.
 *   6. The cognition emitter generates a `__TOOL_DISPATCH` table that maps
 *      each tool name to a `runCognition(<primitive>, <mapped-args>)` call.
 *   7. Prompt callers that declare `tools:` route through `__chatWithTools`
 *      instead of `provider.chat()`. Prompts without tools keep the legacy
 *      direct-chat call.
 *   8. `__chatWithTools` is bounded (LLM_TOOL_CALL_MAX, default 5) and
 *      throws `ToolCallBudgetExceeded` past the cap.
 *   9. SpanKind includes `tool_call` and SpanStatus includes `failed` so the
 *      generated tracer can record per-tool spans.
 *  10. Determinism — emit_cognition + emit_provider produce bitwise-identical
 *      output across two runs.
 *
 * Style follows compiler/src/test_cognition_phase14.ts.
 */

import { Lexer } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";
import { emitCognitionFiles } from "../emit_cognition";
import { emitProviders } from "../emit_provider";
import { emitTraceFiles } from "../emit_traces";

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
  return new Lowering().lower(ast, "phase15-test")[0];
}

function tcheck(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  return new TypeChecker().check(ast);
}

console.log("MarrowScript Cognition Phase 15 Tests — bounded tool calls\n");

// ─── Section 1: T029 negative + positive cases ──────────────────────────────

console.log("Section 1: T029 — only cognition-bearing capabilities can be tools");

{
  // Negative: effect-bearing capability used as a tool — rejected.
  const errs = tcheck(`
    system Bad {
      entity Doc { owns: [body: string] }
      extension_point t(text: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      capability rename(d: Doc, name: string) {
        requires: [name != ""]
        effects: [d.body = name]
        sync: eventual
      }
      prompt p(text: string) {
        model: M
        template: "extension_point:t"
        returns: string
        validate: schema_only
        tools: [rename]
      }
    }
  `);
  const t029 = errs.find(e => e.code === "T029");
  if (t029) ok("T029: effect-bearing capability rejected as tool");
  else fail("T029 missing", `errors: [${errs.map(e => e.code).join(", ")}]`);
}

{
  // Positive: cognition-bearing capability accepted as a tool.
  const errs = tcheck(`
    system Good {
      extension_point t(text: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      capability summarise(text: string) {
        cognition: compress_context using {
          history: text,
          target_tokens: 256
        }
        returns: string
        sync: eventual
        idempotent: true
      }
      prompt p(text: string) {
        model: M
        template: "extension_point:t"
        returns: string
        validate: schema_only
        tools: [summarise]
      }
    }
  `);
  if (errs.length === 0) ok("cognition-bearing tool: 0 type errors");
  else fail("cognition tool", `errors: [${errs.map(e => e.code).join(", ")}]`);
}

// Phase 15 fixture used by sections 2..10.
const phase15System = compile(`
  system Phase15 {
    extension_point tmpl(text: string) { returns: string, stable: false }
    model Tiny {
      provider: openai_compat
      endpoint: "http://localhost:8080/v1"
      name: "qwen2.5:1.5b"
      context_window: 8000
      max_output: 256
      cost_class: tiny
    }

    // Tool capability — not anchored to any entity, so it would otherwise
    // disappear from the lowered module tree. Phase 15's tool_capabilities
    // collection must pick it up via the AST.
    capability search_docs(query: string, max: uint) {
      cognition: compress_context using {
        history: query,
        target_tokens: max
      }
      returns: string
      sync: eventual
      idempotent: true
    }

    capability look_up_id(id: string) {
      cognition: compress_context using {
        history: id,
        target_tokens: 64
      }
      returns: string
      sync: eventual
      idempotent: true
    }

    prompt classify(text: string) {
      model: Tiny
      template: "extension_point:tmpl"
      returns: string
      validate: schema_only
      tools: [search_docs, look_up_id]
    }

    prompt classify_no_tools(text: string) {
      model: Tiny
      template: "extension_point:tmpl"
      returns: string
      validate: none
    }
  }
`);

// ─── Section 2: lowering populates tool_capabilities ────────────────────────

console.log("\nSection 2: lowering populates IRSystem.tool_capabilities");

{
  if (Array.isArray(phase15System.tool_capabilities) &&
      phase15System.tool_capabilities.length === 2) {
    ok("tool_capabilities: 2 entries");
  } else {
    fail("tool_capabilities count", String(phase15System.tool_capabilities?.length));
  }
  const names = phase15System.tool_capabilities.map(t => t.name);
  // Sorted alphabetically: look_up_id, search_docs.
  if (names[0] === "look_up_id" && names[1] === "search_docs") {
    ok("tool_capabilities: sorted alphabetically");
  } else {
    fail("tool order", JSON.stringify(names));
  }
  const sd = phase15System.tool_capabilities.find(t => t.name === "search_docs");
  if (sd && sd.cognition_primitive === "compress_context") {
    ok("search_docs.cognition_primitive: compress_context");
  } else {
    fail("primitive", JSON.stringify(sd));
  }
  if (sd && sd.params.length === 2 && sd.params[0].name === "query" && sd.params[1].name === "max") {
    ok("search_docs.params: query + max");
  } else {
    fail("params", JSON.stringify(sd?.params));
  }
  if (sd && sd.bindings.length === 2 &&
      sd.bindings.some(b => b.param === "history") &&
      sd.bindings.some(b => b.param === "target_tokens")) {
    ok("search_docs.bindings: history + target_tokens");
  } else {
    fail("bindings", JSON.stringify(sd?.bindings));
  }
}

// ─── Section 3: providers/types.ts surface ──────────────────────────────────

console.log("\nSection 3: providers/types.ts exports tool-call shapes");

{
  const providers = emitProviders(phase15System);
  const types = providers.find(f => f.path === "src/providers/types.ts");
  if (!types) {
    fail("types.ts", "not emitted");
  } else {
    for (const sym of [
      "ChatToolCall",
      "ChatToolSpec",
      "tool_calls?:",
      "tool_choice?:",
      "tools?: ChatToolSpec[]",
      "role: \"system\" | \"user\" | \"assistant\" | \"tool\"",
    ]) {
      if (types.content.includes(sym)) ok(`types.ts: ${sym.slice(0, 50)}`);
      else fail(`types.ts ${sym}`, "missing");
    }
  }
}

// ─── Section 4: openai_compat adapter forwards tools ────────────────────────

console.log("\nSection 4: openai_compat adapter forwards tools and parses tool_calls");

{
  const providers = emitProviders(phase15System);
  const oai = providers.find(f => f.path === "src/providers/openai_compat.ts");
  if (!oai) {
    fail("openai_compat.ts", "not emitted");
  } else {
    if (oai.content.includes("body.tools = req.tools.map")) ok("openai_compat: forwards req.tools");
    else fail("openai_compat tools forward", "missing");
    if (oai.content.includes("type: \"function\"") && oai.content.includes("function: { name:")) {
      ok("openai_compat: tools wrapped in OpenAI function-calling shape");
    } else {
      fail("function shape", "missing OpenAI function shape");
    }
    if (oai.content.includes("if (req.tool_choice) body.tool_choice")) {
      ok("openai_compat: forwards tool_choice");
    } else {
      fail("tool_choice", "missing");
    }
    if (oai.content.includes("delete body.response_format")) {
      ok("openai_compat: disables response_format when tools present");
    } else {
      fail("response_format guard", "missing");
    }
    if (oai.content.includes("msg?.tool_calls") && oai.content.includes("tc.function!.name")) {
      ok("openai_compat: parses tool_calls from response");
    } else {
      fail("tool_calls parse", "missing");
    }
  }
}

// ─── Section 5: __TOOL_SPECS in prompts.ts ──────────────────────────────────

console.log("\nSection 5: __TOOL_SPECS table");

{
  const cog = emitCognitionFiles(phase15System);
  const prompts = cog.find(f => f.path === "src/cognition/prompts.ts")!;

  if (prompts.content.includes("const __TOOL_SPECS:")) ok("prompts.ts: __TOOL_SPECS declared");
  else fail("__TOOL_SPECS", "missing");

  // Both tools should be present.
  if (prompts.content.includes('"search_docs": {') && prompts.content.includes('"look_up_id": {')) {
    ok("__TOOL_SPECS: both tools present");
  } else {
    fail("specs entries", "missing one of search_docs/look_up_id");
  }

  // search_docs should have query: { type: string }, max: { type: integer, minimum: 0 }.
  if (prompts.content.includes(`name: "search_docs"`) &&
      prompts.content.includes(`"query":{"type":"string"}`) &&
      prompts.content.includes(`"max":{"type":"integer","minimum":0}`)) {
    ok("search_docs: typed JSON schema for query + max");
  } else {
    fail("schema shape", "missing typed schema");
  }

  // Required: both query and max because uint isn't optional.
  if (prompts.content.includes(`"required":["query","max"]`)) {
    ok("search_docs: required fields query+max");
  } else {
    fail("required", "missing required block");
  }
}

// ─── Section 6: __TOOL_DISPATCH in prompts.ts ───────────────────────────────

console.log("\nSection 6: __TOOL_DISPATCH table");

{
  const cog = emitCognitionFiles(phase15System);
  const prompts = cog.find(f => f.path === "src/cognition/prompts.ts")!;

  if (prompts.content.includes("const __TOOL_DISPATCH:")) ok("prompts.ts: __TOOL_DISPATCH declared");
  else fail("__TOOL_DISPATCH", "missing");

  // search_docs dispatch should call runCognition("compress_context", ...)
  // with bindings: history → args.query, target_tokens → args.max.
  if (prompts.content.includes(`loadRunCognition()("compress_context", { history: args["query"], target_tokens: args["max"] })`)) {
    ok("search_docs: dispatch maps query→history, max→target_tokens via runCognition");
  } else {
    fail("dispatch mapping", "search_docs binding translation wrong");
  }
}

// ─── Section 7: chat-with-tools wiring per prompt ──────────────────────────

console.log("\nSection 7: prompts with tools route through __chatWithTools");

{
  const cog = emitCognitionFiles(phase15System);
  const prompts = cog.find(f => f.path === "src/cognition/prompts.ts")!;

  // The prompt with tools should use __chatWithTools.
  if (prompts.content.includes("await __chatWithTools(")) {
    ok("prompts.ts: classify routes through __chatWithTools");
  } else {
    fail("__chatWithTools call", "not present in classify prompt");
  }

  // The prompt without tools should still call provider.chat() directly.
  if (prompts.content.includes("__model.provider.chat({")) {
    ok("prompts.ts: classify_no_tools keeps direct provider.chat() call");
  } else {
    fail("direct chat", "no direct chat call found");
  }

  // Tool list passed to the loop should contain both tools, alphabetically.
  if (prompts.content.includes(`__TOOL_SPECS["look_up_id"], __TOOL_SPECS["search_docs"]`)) {
    ok("prompts.ts: tool list passed alphabetically");
  } else {
    fail("tool order in call", "expected look_up_id before search_docs");
  }
}

// ─── Section 8: bounded loop + budget ──────────────────────────────────────

console.log("\nSection 8: __chatWithTools is bounded by LLM_TOOL_CALL_MAX");

{
  const cog = emitCognitionFiles(phase15System);
  const prompts = cog.find(f => f.path === "src/cognition/prompts.ts")!;

  if (prompts.content.includes("LLM_TOOL_CALL_MAX")) ok("prompts.ts: reads LLM_TOOL_CALL_MAX env var");
  else fail("env var", "missing");
  if (prompts.content.includes("class ToolCallBudgetExceeded extends Error")) {
    ok("prompts.ts: ToolCallBudgetExceeded error class declared");
  } else {
    fail("error class", "missing");
  }
  if (prompts.content.includes("throw new ToolCallBudgetExceeded(limit, ")) {
    ok("prompts.ts: throws ToolCallBudgetExceeded past cap");
  } else {
    fail("budget throw", "missing");
  }
  if (prompts.content.includes("counter(\"cognition.tool_calls\"") &&
      prompts.content.includes("counter(\"cognition.tool_call_budget_exceeded\"")) {
    ok("prompts.ts: counters for tool_calls + budget_exceeded");
  } else {
    fail("counters", "missing");
  }
}

// ─── Section 9: tracing extensions ──────────────────────────────────────────

console.log("\nSection 9: SpanKind/SpanStatus extended for tool calls");

{
  const traces = emitTraceFiles(phase15System);
  const t = traces.find(f => f.path === "src/cognition/traces.ts")!;
  if (t.content.includes(`| "tool_call"`)) ok("traces.ts: SpanKind includes tool_call");
  else fail("SpanKind tool_call", "missing");
  if (t.content.includes(`| "failed"`)) ok("traces.ts: SpanStatus includes failed");
  else fail("SpanStatus failed", "missing");

  // The prompt body must write a child span per tool call.
  const cog = emitCognitionFiles(phase15System);
  const prompts = cog.find(f => f.path === "src/cognition/prompts.ts")!;
  if (prompts.content.includes(`kind: "tool_call"`)) {
    ok("prompts.ts: emits tool_call span per dispatched call");
  } else {
    fail("tool_call span", "missing");
  }
  if (prompts.content.includes("step: `tool:${tc.name}`")) {
    ok("prompts.ts: tool span step includes tool name");
  } else {
    fail("step name", "missing");
  }
}

// ─── Section 10: determinism ────────────────────────────────────────────────

console.log("\nSection 10: Phase 15 emit is deterministic");

{
  const c1 = emitCognitionFiles(phase15System).map(f => f.path + ":" + f.content).join("\n");
  const c2 = emitCognitionFiles(phase15System).map(f => f.path + ":" + f.content).join("\n");
  if (c1 === c2 && c1.length > 0) ok("emitCognitionFiles: deterministic");
  else fail("cognition determinism", "differ");

  const p1 = emitProviders(phase15System).map(f => f.path + ":" + f.content).join("\n");
  const p2 = emitProviders(phase15System).map(f => f.path + ":" + f.content).join("\n");
  if (p1 === p2 && p1.length > 0) ok("emitProviders: deterministic");
  else fail("provider determinism", "differ");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 15 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
