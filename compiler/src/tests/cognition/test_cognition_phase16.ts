/**
 * MarrowScript Cognition Phase 16 Tests — `evaluation` primitive
 *
 * Verifies:
 *   1. Lexer recognises every Phase 16 keyword (evaluation, cases, expected,
 *      metric, baseline, schedule, passes, contains_class_named, ...).
 *   2. Parser produces an `EvaluationDeclNode` with cases, expectations,
 *      metric, baseline, schedule. Expression bindings parse cleanly.
 *   3. Lowering populates `IRSystem.evaluations` with cases in declaration
 *      order, serialised input expressions, and a closed expectation union.
 *   4. Type checker codes T030–T034 fire on the documented misuse cases:
 *        T030: undeclared prompt
 *        T031: empty cases / nameless case
 *        T032: case input binds a prompt input that doesn't exist
 *        T033: passes:ast_compiles on a non-string return type
 *        T034: duplicate case names within an evaluation
 *   5. emitEvaluationFiles produces 3 file kinds:
 *        eval/<name>.ts (one per evaluation)
 *        eval/index.ts
 *        bin/evaluate.ts
 *      ...only when at least one evaluation is declared.
 *   6. The runner contains the right per-expectation code branches.
 *   7. The CLI emits a working entrypoint that imports the registry.
 *   8. emitEvaluationFiles is bitwise deterministic across two runs.
 */

import { Lexer, TokenKind } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";
import { emitEvaluationFiles, evaluationsNeeded } from "../emit_evaluation";

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
  return new Lowering().lower(ast, "phase16-test")[0];
}

function tcheck(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  return new TypeChecker().check(ast);
}

console.log("MarrowScript Cognition Phase 16 Tests — evaluation primitive\n");

// ─── Section 1: lexer ───────────────────────────────────────────────────────

console.log("Section 1: Lexer recognises Phase 16 keywords");

{
  const src = "evaluation cases expected metric baseline schedule passes contains_class_named must_contain_string must_not_contain_string imports_only_from max_lines min_lines latency_under_ms input pass_rate min_pass_rate on";
  const tokens = new Lexer(src).tokenize();
  const checks: [string, TokenKind][] = [
    ["evaluation", TokenKind.KwEvaluation],
    ["cases", TokenKind.KwCases],
    ["expected", TokenKind.KwExpected],
    ["metric", TokenKind.KwMetric],
    ["baseline", TokenKind.KwBaseline],
    ["schedule", TokenKind.KwSchedule],
    ["passes", TokenKind.KwPasses],
    ["contains_class_named", TokenKind.KwContainsClassNamed],
    ["must_contain_string", TokenKind.KwMustContainString],
    ["must_not_contain_string", TokenKind.KwMustNotContainString],
    ["imports_only_from", TokenKind.KwImportsOnlyFrom],
    ["max_lines", TokenKind.KwMaxLines],
    ["min_lines", TokenKind.KwMinLines],
    ["latency_under_ms", TokenKind.KwLatencyUnderMs],
    ["input", TokenKind.KwInput],
    ["pass_rate", TokenKind.KwPassRate],
    ["min_pass_rate", TokenKind.KwMinPassRate],
    ["on", TokenKind.KwOn],
  ];
  for (const [name, kind] of checks) {
    if (tokens.some(t => t.kind === kind && t.value === name)) ok(`lexer: '${name}' → ${kind}`);
    else fail(`lexer ${name}`, "missing");
  }
}

// ─── Section 2: parsing + lowering ──────────────────────────────────────────

console.log("\nSection 2: Parser and lowering build the IR");

const phase16System = compile(`
  system Phase16 {
    extension_point tmpl_gen(spec: string, level: float) { returns: string, stable: false }
    model Tiny {
      provider: ollama
      name: "qwen2.5:1.5b"
      context_window: 8000
      max_output: 256
      cost_class: tiny
    }

    prompt generate_artifact(spec: string, level: float) {
      model: Tiny
      template: "extension_point:tmpl_gen"
      returns: string
      validate: schema_only
    }

    evaluation generate_quality {
      prompt: generate_artifact

      cases: [
        {
          name: "simple"
          input: { spec: "build a button", level: 0.5 }
          expected: {
            passes: ast_compiles
            contains_class_named: "^[A-Z][a-zA-Z]+$"
            max_lines: 200
            must_contain_string: ["export"]
          }
        },
        {
          name: "complex"
          input: { spec: "build a payment system", level: 0.9 }
          expected: {
            passes: schema_only
            min_lines: 5
            must_not_contain_string: ["TODO", "FIXME"]
            imports_only_from: ["react"]
            latency_under_ms: 30000
          }
        }
      ]

      metric: pass_rate
      baseline: { min_pass_rate: 0.8 }
      schedule: { on: ["pre_commit", "ci_pr"] }
    }
  }
`);

{
  if (Array.isArray(phase16System.evaluations) && phase16System.evaluations.length === 1) {
    ok("IR: 1 evaluation lowered");
  } else {
    fail("evaluations count", String(phase16System.evaluations?.length));
  }
  const ev = phase16System.evaluations[0];
  if (ev.name === "generate_quality") ok("IR: name");
  else fail("name", ev.name);
  if (ev.prompt_ref === "generate_artifact") ok("IR: prompt_ref");
  else fail("prompt_ref", ev.prompt_ref);
  if (ev.cases.length === 2) ok("IR: 2 cases");
  else fail("cases len", String(ev.cases.length));
  if (ev.cases[0].name === "simple" && ev.cases[1].name === "complex") {
    ok("IR: cases preserved declaration order");
  } else {
    fail("case order", JSON.stringify(ev.cases.map(c => c.name)));
  }
  if (ev.metric === "pass_rate") ok("IR: metric=pass_rate");
  else fail("metric", ev.metric);
  if (ev.min_pass_rate === 0.8) ok("IR: min_pass_rate=0.8");
  else fail("baseline", String(ev.min_pass_rate));
  if (JSON.stringify(ev.schedule_on) === JSON.stringify(["pre_commit", "ci_pr"])) {
    ok("IR: schedule_on=[pre_commit,ci_pr]");
  } else {
    fail("schedule", JSON.stringify(ev.schedule_on));
  }

  // Inputs: input bindings for case 'simple' should bind spec + level.
  const c0 = ev.cases[0];
  if (c0.input.length === 2 &&
      c0.input.some(b => b.param === "spec") &&
      c0.input.some(b => b.param === "level")) {
    ok("case[0]: input bindings spec + level");
  } else {
    fail("input bindings", JSON.stringify(c0.input));
  }

  // Expectations for case 'simple': passes, contains_class_named, max_lines, must_contain_string.
  const expKinds = c0.expectations.map(e => e.kind);
  if (expKinds.includes("passes") && expKinds.includes("contains_class_named") &&
      expKinds.includes("max_lines") && expKinds.includes("must_contain_string")) {
    ok("case[0]: 4 expectations of expected kinds");
  } else {
    fail("expectation kinds", JSON.stringify(expKinds));
  }

  // The passes expectation must carry mode = ast_compiles.
  const passExp = c0.expectations.find(e => e.kind === "passes");
  if (passExp && passExp.kind === "passes" && passExp.mode === "ast_compiles") {
    ok("case[0]: passes mode=ast_compiles");
  } else {
    fail("passes mode", JSON.stringify(passExp));
  }

  // imports_only_from + latency_under_ms on case 'complex'.
  const c1 = ev.cases[1];
  const imports = c1.expectations.find(e => e.kind === "imports_only_from");
  if (imports && imports.kind === "imports_only_from" && imports.allowed[0] === "react") {
    ok("case[1]: imports_only_from=[react]");
  } else {
    fail("imports", JSON.stringify(imports));
  }
  const latency = c1.expectations.find(e => e.kind === "latency_under_ms");
  if (latency && latency.kind === "latency_under_ms" && latency.value === 30000) {
    ok("case[1]: latency_under_ms=30000");
  } else {
    fail("latency", JSON.stringify(latency));
  }
}

// ─── Section 3: type-checker negative cases ────────────────────────────────

console.log("\nSection 3: TypeChecker — T030..T034 negative cases");

function expectErr(name: string, code: string, source: string): void {
  const errs = tcheck(source);
  if (errs.some(e => e.code === code)) ok(`${code}: ${name}`);
  else fail(name, `expected ${code}, got [${errs.map(e => e.code).join(", ")}]`);
}

// T030: undeclared prompt
expectErr("evaluation references undeclared prompt", "T030", `
  system X {
    extension_point t(s: string) { returns: string, stable: false }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    evaluation bad {
      prompt: nonexistent_prompt
      cases: [
        { name: "c1", input: { s: "foo" }, expected: { passes: schema_only } }
      ]
    }
  }
`);

// T031: no cases
expectErr("evaluation has no cases", "T031", `
  system X {
    extension_point t(s: string) { returns: string, stable: false }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(s: string) { model: M, template: "extension_point:t", returns: string, validate: schema_only }
    evaluation bad {
      prompt: p
      cases: []
    }
  }
`);

// T032: case input binds unknown prompt input
expectErr("case input binds unknown prompt input", "T032", `
  system X {
    extension_point t(s: string) { returns: string, stable: false }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(s: string) { model: M, template: "extension_point:t", returns: string, validate: schema_only }
    evaluation bad {
      prompt: p
      cases: [
        { name: "c1", input: { mistyped: "foo" }, expected: { passes: schema_only } }
      ]
    }
  }
`);

// T033: passes:ast_compiles on non-string return type
expectErr("passes:ast_compiles on non-string return type", "T033", `
  system X {
    extension_point t(s: string) { returns: string, stable: false }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(s: string) { model: M, template: "extension_point:t", returns: int, validate: schema_only }
    evaluation bad {
      prompt: p
      cases: [
        { name: "c1", input: { s: "x" }, expected: { passes: ast_compiles } }
      ]
    }
  }
`);

// T034: duplicate case names
expectErr("duplicate case name", "T034", `
  system X {
    extension_point t(s: string) { returns: string, stable: false }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(s: string) { model: M, template: "extension_point:t", returns: string, validate: schema_only }
    evaluation bad {
      prompt: p
      cases: [
        { name: "c1", input: { s: "x" }, expected: { passes: schema_only } },
        { name: "c1", input: { s: "y" }, expected: { passes: schema_only } }
      ]
    }
  }
`);

// ─── Section 4: emit_evaluation file shape ─────────────────────────────────

console.log("\nSection 4: emit_evaluation files");

{
  if (evaluationsNeeded(phase16System)) ok("evaluationsNeeded: true when evaluations declared");
  else fail("needed", "expected true");

  const files = emitEvaluationFiles(phase16System);
  const paths = files.map(f => f.path).sort();
  const expected = ["bin/evaluate.ts", "eval/generate_quality.ts", "eval/index.ts"];
  if (JSON.stringify(paths) === JSON.stringify(expected)) {
    ok("emitEvaluationFiles: 3-file tree");
  } else {
    fail("file paths", JSON.stringify(paths));
  }

  const runner = files.find(f => f.path === "eval/generate_quality.ts")!;
  // Per-case dispatch is emitted as `if (i === N)` blocks.
  if (runner.content.includes("if (i === 0) {") && runner.content.includes("if (i === 1) {")) {
    ok("runner: per-case dispatch (if i === 0/1)");
  } else {
    fail("case dispatch", "missing if (i === N)");
  }
  // Expectation branches:
  for (const op of [
    "passes:ast_compiles",
    "contains_class_named",
    "must_contain_string",
    "must_not_contain_string",
    "imports_only_from",
    "max_lines",
    "min_lines",
    "latency_under_ms",
  ]) {
    if (runner.content.includes(`name: "${op}"`)) ok(`runner: emits ${op} check`);
    else fail(`runner ${op}`, "missing");
  }

  // Baseline floor wired in.
  if (runner.content.includes("const baseline = 0.8;")) ok("runner: baseline=0.8");
  else fail("baseline value", "missing");

  // Persists last.json so deltas are computable.
  if (runner.content.includes("generate_quality.last.json")) ok("runner: persists last.json");
  else fail("last.json", "missing");

  // Index re-exports the registry.
  const index = files.find(f => f.path === "eval/index.ts")!;
  if (index.content.includes("export const EVALUATIONS:") &&
      index.content.includes('"generate_quality": run_generate_quality')) {
    ok("index: exports EVALUATIONS map with our eval");
  } else {
    fail("index", "missing EVALUATIONS or run reference");
  }

  // CLI imports the registry.
  const cli = files.find(f => f.path === "bin/evaluate.ts")!;
  if (cli.content.includes('import { EVALUATIONS, listEvaluations }') &&
      cli.content.includes("--list") &&
      cli.content.includes("process.exit(anyFail ? 1 : 0)")) {
    ok("cli: --list flag + correct exit code");
  } else {
    fail("cli", "missing --list or exit logic");
  }
}

// ─── Section 5: skipped when no evaluations ─────────────────────────────────

console.log("\nSection 5: zero evaluations → zero files");

{
  const noEvals = compile(`
    system NoEvals {
      extension_point t(s: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(s: string) { model: M, template: "extension_point:t", returns: string, validate: schema_only }
    }
  `);
  if (!evaluationsNeeded(noEvals)) ok("evaluationsNeeded: false when no evaluations");
  else fail("needed false", "expected false");
  const files = emitEvaluationFiles(noEvals);
  if (files.length === 0) ok("emitEvaluationFiles: zero files");
  else fail("zero files", String(files.length));
}

// ─── Section 6: determinism ─────────────────────────────────────────────────

console.log("\nSection 6: emit_evaluation is deterministic");

{
  const e1 = emitEvaluationFiles(phase16System).map(f => f.path + ":" + f.content).join("\n");
  const e2 = emitEvaluationFiles(phase16System).map(f => f.path + ":" + f.content).join("\n");
  if (e1 === e2 && e1.length > 0) ok("emitEvaluationFiles: deterministic");
  else fail("determinism", "differ");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 16 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
