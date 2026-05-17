/**
 * MarrowScript Cognition Phase 8 Tests — polish + dogfood
 *
 * Verifies the Phase 8 deliverables ship correctly:
 *   1. Two real example .marrow files exist, parse, type-check, lower, and
 *      compile end-to-end.
 *   2. Both examples are deterministic across runs.
 *   3. `cognitive_scaffold` is a valid ScaffoldDomain with a working template.
 *   4. The scaffolded .marrow file compiles cleanly.
 *   5. The spec doc `spec/11_COGNITION_LAYER.md` exists and references the
 *      key compiler artifacts (cognition_catalog.ts, emit_cognition.ts, etc.)
 *      so it stays anchored to real code as the project evolves.
 *   6. The LSP server exposes hover docs for the new cognition keywords.
 *   7. The vscode-ext grammar references the renamed file (was a Phase 0
 *      rename oversight) and includes cognition keywords.
 *
 * Style follows compiler/src/test_cognition_phase7.ts.
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
import { scaffold, ScaffoldDomain } from "../scaffold";

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

console.log("MarrowScript Cognition Phase 8 Tests — polish + dogfood\n");

const ROOT = path.resolve(__dirname, "../..");
const EXAMPLES = path.join(ROOT, "examples");
const SPEC = path.join(ROOT, "spec");
const LSP_SERVER = path.join(ROOT, "lsp", "src", "server.ts");
const VSCODE_PKG = path.join(ROOT, "vscode-ext", "package.json");
const VSCODE_GRAMMAR = path.join(ROOT, "vscode-ext", "syntaxes", "marrow.tmLanguage.json");

// ─── Section 1: example files exist + compile ──────────────────────────────

console.log("Section 1: example files exist + compile end-to-end");

const TRIAGE = path.join(EXAMPLES, "triage_harness.marrow");
const PATCH = path.join(EXAMPLES, "patch_harness.marrow");

if (fs.existsSync(TRIAGE)) ok("examples/triage_harness.marrow exists");
else fail("triage example", "missing");
if (fs.existsSync(PATCH)) ok("examples/patch_harness.marrow exists");
else fail("patch example", "missing");

function compileExample(file: string, label: string): { hash: string | null } {
  if (!fs.existsSync(file)) {
    fail(`compile ${label}`, "file missing");
    return { hash: null };
  }
  const source = fs.readFileSync(file, "utf-8");
  try {
    const tokens = new Lexer(source).tokenize();
    const ast = new Parser(tokens).parse();
    const errs = new TypeChecker().check(ast);
    if (errs.length > 0) {
      fail(`type check ${label}`, errs.map(e => `${e.code}:${e.message}`).slice(0, 3).join("; "));
      return { hash: null };
    }
    ok(`${label}: lex + parse + type check`);
    const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const irSystems = new Lowering().lower(ast, sourceHash);
    const solver = new ConstraintSolver();
    for (const sys of irSystems) {
      const r = solver.solve(sys);
      sys.resolution = r.resolution;
    }
    const files = new FullEmitter().emit(irSystems[0]);
    if (files.length === 0) {
      fail(`emit ${label}`, "no files");
      return { hash: null };
    }
    ok(`${label}: lower + emit produces ${files.length} files`);
    // Stable hash over emitted file contents (sorted by path).
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const h = createHash("sha256");
    for (const f of sorted) {
      h.update(f.path);
      h.update("\u0000");
      h.update(f.content);
      h.update("\u0001");
    }
    return { hash: h.digest("hex").slice(0, 16) };
  } catch (e) {
    fail(`compile ${label}`, String((e as Error).message || e));
    return { hash: null };
  }
}

const triage = compileExample(TRIAGE, "triage_harness");
const patch = compileExample(PATCH, "patch_harness");

// ─── Section 2: examples are deterministic ─────────────────────────────────

console.log("\nSection 2: examples are deterministic");

{
  const t1 = compileExample(TRIAGE, "triage (run 2)");
  if (triage.hash && t1.hash && triage.hash === t1.hash) ok(`triage_harness: deterministic (hash=${triage.hash})`);
  else fail("triage determinism", `${triage.hash} vs ${t1.hash}`);

  const p1 = compileExample(PATCH, "patch (run 2)");
  if (patch.hash && p1.hash && patch.hash === p1.hash) ok(`patch_harness: deterministic (hash=${patch.hash})`);
  else fail("patch determinism", `${patch.hash} vs ${p1.hash}`);
}

// ─── Section 3: cognitive_scaffold init template ───────────────────────────

console.log("\nSection 3: marrowc init --domain cognitive_scaffold");

const TMP = path.join(__dirname, "..", "tmp_phase8_init");
if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });

{
  // ScaffoldDomain must include 'cognitive_scaffold'.
  const domains: ScaffoldDomain[] = [
    "multiplayer_game", "saas_platform", "iot_system",
    "social_network", "marketplace", "realtime_collaboration",
    "cognitive_scaffold",
  ];
  if (domains.includes("cognitive_scaffold" as ScaffoldDomain)) ok("ScaffoldDomain includes 'cognitive_scaffold'");
  else fail("scaffold domain", "missing");

  const result = scaffold({
    name: "phase8_test",
    domain: "cognitive_scaffold",
    outDir: TMP,
  });
  if (result.created.length >= 2) ok(`scaffold writes ${result.created.length} files`);
  else fail("scaffold output", `only ${result.created.length} file(s)`);

  const mainFile = path.join(TMP, "phase8_test.marrow");
  if (fs.existsSync(mainFile)) ok("scaffold writes <name>.marrow");
  else fail("main marrow file", "missing");
  const readmeFile = path.join(TMP, "README.md");
  if (fs.existsSync(readmeFile)) ok("scaffold writes README.md");
  else fail("README", "missing");

  // The scaffolded .marrow must compile (extension-point bodies aside).
  if (fs.existsSync(mainFile)) {
    const source = fs.readFileSync(mainFile, "utf-8");
    if (source.includes("system Phase8Test")) ok("scaffold replaces system name with PascalCase project name");
    else fail("system name rewrite", source.slice(0, 80));
    if (source.includes("domain: cognitive_scaffold")) ok("scaffold sets domain: cognitive_scaffold");
    else fail("domain set", "missing");
    // Compile through the pipeline.
    try {
      const tokens = new Lexer(source).tokenize();
      const ast = new Parser(tokens).parse();
      const errs = new TypeChecker().check(ast);
      if (errs.length === 0) ok("scaffolded file: lex + parse + type check (0 errors)");
      else fail("scaffold type check", errs.map(e => `${e.code}:${e.message}`).slice(0, 3).join("; "));
    } catch (e) {
      fail("scaffold compile", String((e as Error).message || e));
    }
  }

  // Confirm the scaffolded file declares all the cognition primitives a
  // beginner needs to see exactly once: model + prompt + cache + extension_point.
  if (fs.existsSync(mainFile)) {
    const source = fs.readFileSync(mainFile, "utf-8");
    for (const tok of [
      "model Tiny",
      "prompt classify",
      "extension_point tmpl_classify",
      "cache: { key:",
      "validate: schema_only",
    ]) {
      if (source.includes(tok)) ok(`scaffold contains: \`${tok}...\``);
      else fail(`scaffold missing ${tok}`, "");
    }
  }
}

if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });

// ─── Section 4: spec doc exists and is anchored ────────────────────────────

console.log("\nSection 4: spec/11_COGNITION_LAYER.md");

const SPEC_DOC = path.join(SPEC, "11_COGNITION_LAYER.md");
if (fs.existsSync(SPEC_DOC)) ok("spec/11_COGNITION_LAYER.md exists");
else fail("spec doc", "missing");

if (fs.existsSync(SPEC_DOC)) {
  const doc = fs.readFileSync(SPEC_DOC, "utf-8");
  for (const anchor of [
    "cognition_catalog.ts",
    "emit_cognition.ts",
    "compiler/src/cli.ts",
    "T020", "T021", "T022", "T023", "T024", "T025", "T026", "T027", "T028",
    "schema_only", "ast_compiles", "retry_with_repair_prompt",
    "low_confidence", "budget_exceeded",
    "ollama", "openai_compat", "llamacpp", "koboldcpp",
    "vote", "judge_pairwise", "argmax_score", "consensus_check",
    "compress_context", "semantic_slice",
  ]) {
    if (doc.includes(anchor)) ok(`spec doc references ${anchor}`);
    else fail(`spec missing ${anchor}`, "");
  }
}

// 01_LANGUAGE_OVERVIEW.md should reference the new chapter.
const OVERVIEW = path.join(SPEC, "01_LANGUAGE_OVERVIEW.md");
if (fs.existsSync(OVERVIEW)) {
  const doc = fs.readFileSync(OVERVIEW, "utf-8");
  if (doc.includes("11_COGNITION_LAYER.md")) ok("01_LANGUAGE_OVERVIEW.md links 11_COGNITION_LAYER.md");
  else fail("overview link", "missing");
  if (doc.includes("Cognition Layer (LLM Harness)")) ok("01_LANGUAGE_OVERVIEW.md introduces Cognition Layer section");
  else fail("overview cognition section", "missing");
}

// ─── Section 5: LSP server hover docs cover cognition keywords ─────────────

console.log("\nSection 5: LSP server.ts hover docs cover cognition keywords");

if (fs.existsSync(LSP_SERVER)) {
  const lsp = fs.readFileSync(LSP_SERVER, "utf-8");
  for (const kw of [
    "model", "prompt", "router", "cognition", "provider", "endpoint",
    "template", "tier", "validate", "on_invalid", "cache", "tools",
    "confidence_threshold", "on_low_confidence",
    "schema_only", "ast_compiles", "retry_with_repair_prompt", "escalate",
    "ollama", "openai_compat", "llamacpp", "koboldcpp", "http",
    "compress_context", "semantic_slice", "vote", "judge_pairwise",
    "argmax_score", "consensus_check",
  ]) {
    // KEYWORD_DOCS keys are JS property names — match `<kw>:` with at least
    // 4 leading whitespace chars (object literal indentation) followed by `:`
    // and then a quoted markdown value, so we don't accidentally match
    // identifier usages within the LSP code.
    const re = new RegExp(`\\n\\s+['"]?${kw}['"]?\\s*:\\s*['"]\\*\\*${kw}\\*\\*`);
    if (re.test(lsp)) ok(`KEYWORD_DOCS has entry for '${kw}'`);
    else fail(`KEYWORD_DOCS missing ${kw}`, "");
  }
  // model_body / prompt_body / router_body completion contexts wired up.
  for (const ctx of ["'model_body'", "'prompt_body'", "'router_body'"]) {
    if (lsp.includes(ctx)) ok(`LSP detectContext returns ${ctx}`);
    else fail(`LSP context ${ctx}`, "missing");
  }
  // DocSymbols extended.
  for (const field of ["models:", "prompts:", "routers:", "extensionPoints:"]) {
    if (lsp.includes(field)) ok(`DocSymbols has ${field} map`);
    else fail(`DocSymbols ${field}`, "missing");
  }
}

// ─── Section 6: vscode-ext grammar + package ────────────────────────────────

console.log("\nSection 6: vscode-ext grammar references the renamed file");

if (fs.existsSync(VSCODE_PKG)) {
  const pkg = JSON.parse(fs.readFileSync(VSCODE_PKG, "utf-8"));
  const grammars = pkg?.contributes?.grammars ?? [];
  const grammarPath = grammars[0]?.path ?? "";
  if (grammarPath.includes("marrow.tmLanguage.json")) ok("vscode-ext package.json references marrow.tmLanguage.json");
  else fail("grammar path", grammarPath);
}

if (fs.existsSync(VSCODE_GRAMMAR)) {
  const grammar = fs.readFileSync(VSCODE_GRAMMAR, "utf-8");
  for (const kw of ["model", "prompt", "router", "cognition", "provider", "template", "tier", "validate", "on_invalid", "cache", "tools", "confidence_threshold", "on_low_confidence", "ollama", "openai_compat", "llamacpp", "koboldcpp", "schema_only", "ast_compiles"]) {
    if (grammar.includes(kw)) ok(`grammar covers '${kw}'`);
    else fail(`grammar missing ${kw}`, "");
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 8 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
