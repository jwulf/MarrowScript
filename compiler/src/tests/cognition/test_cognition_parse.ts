/**
 * MarrowScript Cognition Layer Tests — Phase 1 (substrate)
 *
 * Verifies the LLM Harness Phase 1 additions:
 *   1. Lexer: new keywords tokenize as dedicated kinds, not as identifiers.
 *   2. Parser: model, prompt, router, and capability { cognition: ... } parse
 *      into the right AST shape and preserve declaration order.
 *   3. Lowering: model → IRCogModel, prompt → IRPrompt, router → IRRouter,
 *      and capability.cognition → IRMethod.cognition.
 *   4. TypeChecker: positive cases pass; T020–T027 fire for the documented
 *      negative cases.
 *   5. Determinism: two runs of lex / parse / lower produce byte-identical JSON.
 *
 * Style follows compiler/src/test_typechecker.ts and compiler/src/test.ts.
 */

import { Lexer, TokenKind } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";
import * as AST from "../ast";

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

function compileToAst(source: string) {
  const tokens = new Lexer(source).tokenize();
  return { tokens, ast: new Parser(tokens).parse() };
}

function compileToIR(source: string) {
  const { ast } = compileToAst(source);
  return new Lowering().lower(ast, "test-hash");
}

function tcheck(source: string) {
  const { ast } = compileToAst(source);
  return new TypeChecker().check(ast);
}

console.log("MarrowScript Cognition Layer Tests — Phase 1\n");

// ─── Section 1: Lexer ────────────────────────────────────────────────────────

console.log("Section 1: Lexer recognizes new keywords");
{
  const src = "model prompt router cognition provider endpoint context_window max_output temperature top_p stop cost_class latency_class vram_mb quant template validate on_invalid cache tools tier by on_low_confidence confidence_threshold fallback max to tiny small medium large slow fail escalate retry_with_repair_prompt schema_only ast_compiles custom";
  const tokens = new Lexer(src).tokenize();
  const idents = tokens.filter(t => t.kind === TokenKind.Identifier);
  if (idents.length === 0) {
    ok("all 36 cognition keywords lex as dedicated keyword tokens");
  } else {
    fail("cognition keywords",
      `expected 0 Identifier tokens, found ${idents.length}: ${idents.map(t => t.value).join(", ")}`);
  }

  // Spot-check a few specific kinds to guard against silent enum drift.
  const expectedKinds: Array<[string, TokenKind]> = [
    ["model", TokenKind.KwModel],
    ["prompt", TokenKind.KwPrompt],
    ["router", TokenKind.KwRouter],
    ["cognition", TokenKind.KwCognition],
    ["provider", TokenKind.KwProvider],
    ["template", TokenKind.KwTemplate],
    ["validate", TokenKind.KwValidate],
    ["on_invalid", TokenKind.KwOnInvalid],
    ["cache", TokenKind.KwCache],
    ["tools", TokenKind.KwTools],
    ["tier", TokenKind.KwTier],
    ["retry_with_repair_prompt", TokenKind.KwRetryWithRepairPrompt],
    ["schema_only", TokenKind.KwSchemaOnly],
    ["ast_compiles", TokenKind.KwAstCompiles],
  ];
  for (const [lexeme, kind] of expectedKinds) {
    const t = tokens.find(t => t.value === lexeme);
    if (t && t.kind === kind) ok(`'${lexeme}' is ${kind}`);
    else fail(`'${lexeme}'`, `expected ${kind}, got ${t ? t.kind : "missing"}`);
  }
}

// ─── Section 2: Parser ───────────────────────────────────────────────────────

console.log("\nSection 2: Parser builds correct AST nodes");
{
  const src = `
    system Hello {
      domain: cognitive_scaffold

      extension_point tmpl_classify(text: string) {
        returns: string
        stable: true
      }

      model Local {
        provider: ollama
        name: "qwen2.5-coder:1.5b"
        context_window: 32000
        max_output: 256
        temperature: 0.0
        cost_class: tiny
        latency_class: fast
      }

      model Bigger {
        provider: openai_compat
        endpoint: "http://localhost:8080/v1"
        name: "phi-3.5-mini"
        context_window: 128000
        max_output: 2048
        cost_class: small
      }

      router cheapest_valid {
        by: input.complexity
        tier tiny  { max: 0.2 -> Local }
        tier rest  {           -> Bigger }
        on_low_confidence: escalate
        confidence_threshold: 0.65
        fallback: Bigger
      }

      capability ping(text: string) {
        cognition: compress_context using {
          history: text,
          target_tokens: 256
        }
        returns: string
        sync: eventual
        idempotent: true
      }

      prompt classify(text: string) {
        model: Local
        template: "extension_point:tmpl_classify"
        returns: string
        timeout: 5s
        idempotent: true
        validate: schema_only
        on_invalid: retry_with_repair_prompt
        retry: { max_attempts: 2, backoff: fixed, interval: 200ms }
        cache: { key: hash(text), ttl: 1h }
        constraints: [output.length <= 256]
        tools: [ping]
      }

      capability summarize(history: string) {
        cognition: compress_context using {
          history: history,
          target_tokens: 4000
        }
        returns: string
        sync: eventual
        idempotent: true
      }
    }
  `;
  const { ast } = compileToAst(src);
  const sys = ast.systems[0];

  const models = sys.declarations.filter((d): d is AST.ModelDeclNode => d.kind === "ModelDecl");
  const prompts = sys.declarations.filter((d): d is AST.PromptDeclNode => d.kind === "PromptDecl");
  const routers = sys.declarations.filter((d): d is AST.RouterDeclNode => d.kind === "RouterDecl");
  const caps = sys.declarations.filter((d): d is AST.CapabilityDeclNode => d.kind === "CapabilityDecl");

  if (models.length === 2) ok("two model decls parsed");
  else fail("model count", `expected 2, got ${models.length}`);

  const local = models.find(m => m.name === "Local")!;
  if (local && local.provider === "ollama" && local.modelName === "qwen2.5-coder:1.5b" &&
      local.contextWindow === 32000 && local.maxOutput === 256 &&
      local.temperature === 0 && local.costClass === "tiny" && local.latencyClass === "fast") {
    ok("model Local fields parsed correctly");
  } else {
    fail("model Local fields", JSON.stringify(local));
  }

  const bigger = models.find(m => m.name === "Bigger")!;
  if (bigger && bigger.provider === "openai_compat" && bigger.endpoint === "http://localhost:8080/v1") {
    ok("model Bigger has provider + endpoint");
  } else {
    fail("model Bigger", JSON.stringify(bigger));
  }

  if (prompts.length === 1 && prompts[0].name === "classify") ok("prompt classify parsed");
  else fail("prompt count", `expected 1, got ${prompts.length}`);

  const p = prompts[0];
  if (p.modelRef === "Local" && p.routerRef === null) ok("prompt references model Local (not router)");
  else fail("prompt model ref", `modelRef=${p.modelRef} routerRef=${p.routerRef}`);

  if (p.template === "extension_point:tmpl_classify") ok("prompt template references extension_point");
  else fail("prompt template", String(p.template));

  if (p.validate.kind === "schema_only") ok("validate: schema_only parsed");
  else fail("validate", JSON.stringify(p.validate));

  if (p.onInvalid === "retry_with_repair_prompt") ok("on_invalid: retry_with_repair_prompt parsed");
  else fail("on_invalid", String(p.onInvalid));

  if (p.retry && p.retry.maxAttempts === 2 && p.retry.backoff === "fixed" && p.retry.interval === "200ms") {
    ok("prompt retry policy parsed");
  } else {
    fail("retry policy", JSON.stringify(p.retry));
  }

  if (p.cache && p.cache.keyExpr && p.cache.ttl === "1h") ok("prompt cache parsed (key + ttl)");
  else fail("cache", JSON.stringify(p.cache));

  if (p.constraints.length === 1) ok("prompt has 1 output constraint");
  else fail("constraints count", String(p.constraints.length));

  if (p.allowedTools.length === 1 && p.allowedTools[0] === "ping") ok("prompt tools: [ping] parsed");
  else fail("tools", JSON.stringify(p.allowedTools));

  if (p.idempotent === true) ok("prompt idempotent: true parsed");
  else fail("idempotent", String(p.idempotent));

  if (p.timeout === "5s") ok("prompt timeout: 5s parsed");
  else fail("timeout", String(p.timeout));

  if (routers.length === 1 && routers[0].name === "cheapest_valid") ok("router cheapest_valid parsed");
  else fail("router count", `expected 1, got ${routers.length}`);

  const r = routers[0];
  if (r.tiers.length === 2 && r.tiers[0].name === "tiny" && r.tiers[0].max === 0.2 && r.tiers[0].modelRef === "Local") {
    ok("router tier tiny parsed (max=0.2 -> Local)");
  } else {
    fail("router tier tiny", JSON.stringify(r.tiers[0]));
  }
  if (r.tiers[1] && r.tiers[1].name === "rest" && r.tiers[1].max === null && r.tiers[1].modelRef === "Bigger") {
    ok("router default tier rest parsed (no max -> Bigger)");
  } else {
    fail("router default tier", JSON.stringify(r.tiers[1]));
  }
  if (r.onLowConfidence === "escalate") ok("router on_low_confidence: escalate parsed");
  else fail("on_low_confidence", String(r.onLowConfidence));
  if (r.confidenceThreshold === 0.65) ok("router confidence_threshold: 0.65 parsed");
  else fail("confidence_threshold", String(r.confidenceThreshold));
  if (r.fallbackModel === "Bigger") ok("router fallback: Bigger parsed");
  else fail("fallback", String(r.fallbackModel));

  // Capability with cognition modifier
  const summarize = caps.find(c => c.name === "summarize")!;
  if (summarize && summarize.cognition && summarize.cognition.name === "compress_context") {
    ok("capability cognition: compress_context parsed");
  } else {
    fail("capability cognition", JSON.stringify(summarize?.cognition));
  }
  if (summarize && summarize.cognition && summarize.cognition.using.length === 2) {
    ok("capability cognition has 2 bindings");
  } else {
    fail("cognition bindings", JSON.stringify(summarize?.cognition?.using));
  }
}

// ─── Section 3: Parser determinism ───────────────────────────────────────────

console.log("\nSection 3: Parser is deterministic on cognition decls");
{
  const src = `
    system D {
      extension_point tmpl(x: string) {
        returns: string
        stable: true
      }
      model M {
        provider: ollama
        name: "x"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }
      router R {
        by: input.x
        tier a { max: 0.5 -> M }
        tier b { -> M }
        on_low_confidence: fail
      }
      prompt P(x: string) {
        model: M
        template: "extension_point:tmpl"
        returns: string
      }
    }
  `;
  const a1 = JSON.stringify(compileToAst(src).ast);
  const a2 = JSON.stringify(compileToAst(src).ast);
  if (a1 === a2) ok("two parses produce byte-identical AST JSON");
  else fail("parser determinism", "two parses differ");
}

// ─── Section 4: Lowering ─────────────────────────────────────────────────────

console.log("\nSection 4: Lowering produces correct IR shapes");
{
  const src = `
    system L {
      entity Doc {
        owns: [text: string]
      }
      extension_point tmpl(x: string) {
        returns: string
        stable: true
      }
      model M {
        provider: ollama
        name: "qwen2.5:1.5b"
        context_window: 32000
        max_output: 512
        temperature: 0.1
        cost_class: small
      }
      router R {
        by: input.size
        tier small { max: 1000 -> M }
        tier big   { -> M }
        on_low_confidence: escalate
      }
      prompt P(text: string) {
        router: R
        template: "extension_point:tmpl"
        returns: string
        timeout: 10s
        idempotent: true
        retry: { max_attempts: 3, backoff: exponential, interval: 1s }
        cache: { ttl: 1h }
      }
      capability summarize_doc(doc: Doc) {
        cognition: vote using { candidates: doc.text, k: 3 }
        returns: string
        sync: eventual
      }
    }
  `;
  const [sys] = compileToIR(src);

  if (sys.models.length === 1 && sys.models[0].name === "M") ok("IR has 1 model");
  else fail("IR models", JSON.stringify(sys.models.map(m => m.name)));

  const m = sys.models[0];
  if (m.provider === "ollama" && m.model_name === "qwen2.5:1.5b" &&
      m.context_window === 32000 && m.max_output === 512 &&
      m.temperature === 0.1 && m.cost_class === "small") {
    ok("IRCogModel fields populated");
  } else {
    fail("IRCogModel", JSON.stringify(m));
  }

  if (sys.routers.length === 1 && sys.routers[0].tiers.length === 2) ok("IR has 1 router with 2 tiers");
  else fail("IR routers", JSON.stringify(sys.routers));

  const ir_router = sys.routers[0];
  if (ir_router.tiers[0].max === 1000 && ir_router.tiers[0].model_ref === "M" &&
      ir_router.tiers[1].max === null) {
    ok("router tier maxes preserved (1000, then default)");
  } else {
    fail("router tiers", JSON.stringify(ir_router.tiers));
  }
  if (ir_router.by_expr.includes("input") && ir_router.by_expr.includes("size")) {
    ok("router by_expr serialized");
  } else {
    fail("by_expr", ir_router.by_expr);
  }

  if (sys.prompts.length === 1) ok("IR has 1 prompt");
  else fail("IR prompts", String(sys.prompts.length));

  const ir_p = sys.prompts[0];
  if (ir_p.router_ref === "R" && ir_p.model_ref === null) ok("prompt routes through R (not direct model)");
  else fail("prompt routing", `model_ref=${ir_p.model_ref} router_ref=${ir_p.router_ref}`);
  if (ir_p.timeout_ms === 10_000) ok("prompt timeout lowered to ms");
  else fail("timeout_ms", String(ir_p.timeout_ms));
  if (ir_p.retry && ir_p.retry.max_attempts === 3 && ir_p.retry.backoff === "exponential" && ir_p.retry.interval_ms === 1000) {
    ok("prompt retry lowered correctly");
  } else {
    fail("retry IR", JSON.stringify(ir_p.retry));
  }
  if (ir_p.cache && ir_p.cache.ttl_ms === 3_600_000) ok("prompt cache ttl lowered to ms");
  else fail("cache ttl", JSON.stringify(ir_p.cache));
  if (ir_p.idempotent === true) ok("prompt idempotent flag passed through");
  else fail("idempotent IR", String(ir_p.idempotent));

  // Capability with cognition modifier — bound to entity Doc.
  const docMod = sys.modules.find(mod => mod.kind === "api_service" && mod.name === "DocService");
  const cMethod = docMod?.interfaces[0].methods.find(meth => meth.name === "summarize_doc");
  if (cMethod && cMethod.cognition && cMethod.cognition.catalog_name === "vote") {
    ok("IRMethod.cognition populated for capability with cognition: modifier");
  } else {
    fail("IRMethod.cognition", JSON.stringify(cMethod?.cognition));
  }
  if (cMethod && cMethod.cognition && cMethod.cognition.bindings.length === 2) {
    ok("IRMethod.cognition.bindings has 2 entries");
  } else {
    fail("cognition bindings", JSON.stringify(cMethod?.cognition?.bindings));
  }
}

// ─── Section 5: Lowering determinism ─────────────────────────────────────────

console.log("\nSection 5: Lowering is deterministic");
{
  const src = `
    system D2 {
      extension_point tmpl(x: string) {
        returns: string
        stable: true
      }
      model M {
        provider: ollama
        name: "x"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }
      prompt P(x: string) {
        model: M
        template: "extension_point:tmpl"
        returns: string
      }
    }
  `;
  const ir1 = JSON.stringify(compileToIR(src));
  const ir2 = JSON.stringify(compileToIR(src));
  if (ir1 === ir2) ok("two lowerings produce byte-identical IR JSON");
  else fail("lowering determinism", "two lowerings differ");
}

// ─── Section 6: TypeChecker — positive cases ─────────────────────────────────

console.log("\nSection 6: TypeChecker accepts well-formed cognition decls");
{
  const okSrc = `
    system OK {
      extension_point tmpl(x: string) { returns: string, stable: true }
      model M {
        provider: ollama
        name: "qwen2.5:1.5b"
        context_window: 32000
        max_output: 512
        cost_class: small
      }
      router R {
        by: input.x
        tier a { max: 0.5 -> M }
        tier b {           -> M }
      }
      capability help(x: string) {
        cognition: compress_context using {
          history: x,
          target_tokens: 128
        }
        returns: string
        sync: eventual
        idempotent: true
      }
      prompt classify(text: string) {
        model: M
        template: "extension_point:tmpl"
        returns: string
        validate: schema_only
        tools: [help]
      }
    }
  `;
  const errs = tcheck(okSrc);
  if (errs.length === 0) ok("well-formed program: 0 type errors");
  else fail("well-formed", `unexpected errors: ${errs.map(e => `${e.code}:${e.message}`).join(", ")}`);
}

// ─── Section 7: TypeChecker — negative cases (T020–T027) ─────────────────────

function expectErr(name: string, code: string, src: string): void {
  const errs = tcheck(src);
  const found = errs.find(e => e.code === code);
  if (found) {
    ok(`${code} ${name}`);
  } else {
    fail(`${code} ${name}`,
      `expected ${code}, got [${errs.map(e => e.code).join(", ") || "no errors"}]`);
  }
}

console.log("\nSection 7: TypeChecker reports cognition errors with stable codes");

expectErr("model missing provider", "T020", `
  system X {
    model M { name: "x", context_window: 1000, max_output: 256, cost_class: tiny }
  }
`);

expectErr("model openai_compat without endpoint", "T020", `
  system X {
    model M { provider: openai_compat, name: "x", context_window: 1000, max_output: 256, cost_class: tiny }
  }
`);

expectErr("prompt references undeclared model", "T021", `
  system X {
    extension_point t(x: string) { returns: string, stable: true }
    prompt P(x: string) {
      model: NotAModel
      template: "extension_point:t"
      returns: string
    }
  }
`);

expectErr("prompt references undeclared router", "T021", `
  system X {
    extension_point t(x: string) { returns: string, stable: true }
    prompt P(x: string) {
      router: NotARouter
      template: "extension_point:t"
      returns: string
    }
  }
`);

expectErr("prompt references neither model nor router", "T022", `
  system X {
    extension_point t(x: string) { returns: string, stable: true }
    prompt P(x: string) {
      template: "extension_point:t"
      returns: string
    }
  }
`);

expectErr("prompt references both model and router", "T022", `
  system X {
    extension_point t(x: string) { returns: string, stable: true }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    router R { by: input.x, tier z { -> M } }
    prompt P(x: string) {
      model: M
      router: R
      template: "extension_point:t"
      returns: string
    }
  }
`);

expectErr("prompt allowed_tools references undeclared capability", "T023", `
  system X {
    extension_point t(x: string) { returns: string, stable: true }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt P(x: string) {
      model: M
      template: "extension_point:t"
      returns: string
      tools: [does_not_exist]
    }
  }
`);

expectErr("prompt template references undeclared extension_point", "T024", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt P(x: string) {
      model: M
      template: "extension_point:does_not_exist"
      returns: string
    }
  }
`);

expectErr("router tier references undeclared model", "T025", `
  system X {
    router R { by: input.x, tier z { -> NotAModel } }
  }
`);

expectErr("router non-last tier missing max", "T026", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    router R {
      by: input.x
      tier a { -> M }
      tier b { max: 0.5 -> M }
    }
  }
`);

expectErr("router last tier has explicit max (no default)", "T026", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    router R {
      by: input.x
      tier a { max: 0.5 -> M }
      tier b { max: 1.0 -> M }
    }
  }
`);

expectErr("router tier maxes not strictly increasing", "T026", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    router R {
      by: input.x
      tier a { max: 0.6 -> M }
      tier b { max: 0.5 -> M }
      tier c { -> M }
    }
  }
`);

expectErr("router fallback references undeclared model", "T027", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    router R {
      by: input.x
      tier z { -> M }
      fallback: NotAModel
    }
  }
`);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Cognition Phase 1 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
