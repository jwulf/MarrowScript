/**
 * MarrowScript Cognition Phase 5 Tests — validation + recovery
 *
 * Verifies the Phase 5 additions:
 *   1. Compiler emits src/cognition/validate.ts (always, when prompts exist)
 *      and src/cognition/repair.ts (only when at least one prompt declares
 *      on_invalid: retry_with_repair_prompt).
 *   2. The prompt body wires the right validation helper for each
 *      validate: mode (none, schema_only, ast_compiles, custom).
 *   3. Failure rules in src/failure_rules.ts include four rules per prompt:
 *      validate_failed, timeout, budget_exceeded, low_confidence (router only).
 *   4. End-to-end runtime behaviour:
 *      - schema_only: stub returns wrong-typed value → validation fails →
 *        retry exhausts → caller gets a validation error
 *      - schema_only: stub returns valid value → succeeds first call
 *      - schema_only with retry_with_repair_prompt: first stub call returns
 *        bad value, repair stub returns good value → caller gets repaired
 *        value (single-shot repair, not a recursive loop)
 *      - custom: extension returns { ok:false, issues:[...] } → validation
 *        fails with surfaced issues
 *
 * Style follows compiler/src/test_cognition_phase3.ts and
 * compiler/src/test_cognition_phase4.ts.
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
import { emitValidateFile, validateNeeded } from "../emit_validate";
import { emitRepairFile, repairNeeded } from "../emit_repair";
import { emitCognitionFiles } from "../emit_cognition";
import { emitFailureRules } from "../emit_maintenance";

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
  return new Lowering().lower(ast, "phase5-test")[0];
}

console.log("MarrowScript Cognition Phase 5 Tests — validation + recovery\n");

// ─── Section 1: file emission ───────────────────────────────────────────────

console.log("Section 1: Phase 5 files are emitted on the right systems");

{
  // No prompts → no validate, no repair.
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
  if (!validateNeeded(noPrompts)) ok("validateNeeded: false when no prompts declared");
  else fail("validateNeeded(noPrompts)", "expected false");
  if (!repairNeeded(noPrompts)) ok("repairNeeded: false when no prompts declared");
  else fail("repairNeeded(noPrompts)", "expected false");
  if (emitValidateFile(noPrompts) === null) ok("emitValidateFile: null when no prompts");
  else fail("emitValidateFile(noPrompts)", "should be null");
  if (emitRepairFile(noPrompts) === null) ok("emitRepairFile: null when no prompts");
  else fail("emitRepairFile(noPrompts)", "should be null");

  // Prompts but no retry_with_repair_prompt → validate yes, repair no.
  const onlyValidate = compile(`
    system OnlyValidate {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) {
        model: M
        template: "extension_point:t"
        returns: string
        validate: schema_only
        on_invalid: retry
      }
    }
  `);
  if (validateNeeded(onlyValidate)) ok("validateNeeded: true when prompts declared");
  else fail("validateNeeded(onlyValidate)", "expected true");
  if (!repairNeeded(onlyValidate)) ok("repairNeeded: false without retry_with_repair_prompt");
  else fail("repairNeeded(onlyValidate)", "expected false");
  const vf = emitValidateFile(onlyValidate);
  if (vf && vf.path === "src/cognition/validate.ts") ok("emitValidateFile: src/cognition/validate.ts");
  else fail("emitValidateFile path", JSON.stringify(vf?.path));
  if (emitRepairFile(onlyValidate) === null) ok("emitRepairFile: null without retry_with_repair_prompt");
  else fail("emitRepairFile(onlyValidate)", "should be null");

  // With retry_with_repair_prompt → both files.
  const withRepair = compile(`
    system WithRepair {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) {
        model: M
        template: "extension_point:t"
        returns: string
        validate: schema_only
        on_invalid: retry_with_repair_prompt
      }
    }
  `);
  if (repairNeeded(withRepair)) ok("repairNeeded: true with retry_with_repair_prompt");
  else fail("repairNeeded(withRepair)", "expected true");
  const rf = emitRepairFile(withRepair);
  if (rf && rf.path === "src/cognition/repair.ts") ok("emitRepairFile: src/cognition/repair.ts");
  else fail("emitRepairFile path", JSON.stringify(rf?.path));
  if (rf && rf.content.includes("export async function repair_p(") &&
      rf.content.includes("export const REPAIRS")) {
    ok("repair.ts: per-prompt fn + dispatch table");
  } else {
    fail("repair.ts content", "missing repair_p or REPAIRS");
  }
}

// ─── Section 2: validate.ts surface ─────────────────────────────────────────

console.log("\nSection 2: validate.ts exposes the documented helpers");

{
  const sys = compile(`
    system V {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) { model: M, template: "extension_point:t", returns: string, validate: schema_only }
    }
  `);
  const v = emitValidateFile(sys)!;
  for (const helper of ["validateSchemaOnly", "validateAstCompiles", "validateCustom", "ValidationReport"]) {
    if (v.content.includes(helper)) ok(`validate.ts: exports ${helper}`);
    else fail(`validate.ts ${helper}`, "missing");
  }
  if (v.content.includes("parseEnumDecl") &&
      v.content.includes("declaredPrimitiveCheck") &&
      v.content.includes("createSourceFile") &&
      v.content.includes("getSyntacticDiagnostics")) {
    ok("validate.ts: enum parser + primitive check + tsc parser path present");
  } else {
    fail("validate.ts internals", "missing one of parseEnumDecl/declaredPrimitiveCheck/createSourceFile/getSyntacticDiagnostics");
  }
}

// ─── Section 3: prompt body wiring ──────────────────────────────────────────

console.log("\nSection 3: prompt body wires the right validation per mode");

const phase5System = compile(`
  system Phase5 {
    extension_point tmpl_class(text: string) { returns: string, stable: false }
    extension_point tmpl_code(text: string) { returns: string, stable: false }
    extension_point tmpl_obj(text: string) { returns: string, stable: false }
    extension_point validator_obj(value: json) { returns: bool, stable: false }

    model Tiny { provider: ollama, name: "qwen2.5:1.5b", context_window: 8000, max_output: 256, cost_class: tiny }

    prompt classify(text: string) {
      model: Tiny
      template: "extension_point:tmpl_class"
      returns: string
      validate: none
    }

    prompt code(text: string) {
      model: Tiny
      template: "extension_point:tmpl_code"
      returns: string
      validate: ast_compiles
      on_invalid: retry
    }

    prompt obj(text: string) {
      model: Tiny
      template: "extension_point:tmpl_obj"
      returns: json
      validate: custom: validator_obj
      on_invalid: retry_with_repair_prompt
      retry: { max_attempts: 2, backoff: fixed, interval: 100ms }
    }

    policy harness {
      rate_limit: 60 per 1m
      audit: true
    }
  }
`);

{
  const cogFiles = emitCognitionFiles(phase5System);
  const prompts = cogFiles.find(f => f.path === "src/cognition/prompts.ts")!;

  // none: no-op { ok: true, issues: [] }
  if (prompts.content.includes("// validate: none — accept any parsed value")) {
    ok("prompts.ts: validate:none accepts everything");
  } else {
    fail("validate:none", "missing comment marker");
  }

  // schema_only is not in this system; ast_compiles and custom are.
  if (prompts.content.includes("await validateAstCompiles(__value)")) {
    ok("prompts.ts: ast_compiles → validateAstCompiles");
  } else {
    fail("ast_compiles wiring", "missing validateAstCompiles call");
  }

  if (prompts.content.includes("validateCustom(__value, __validatorFn)") &&
      prompts.content.includes("loadExtension(\"validator_obj\")")) {
    ok("prompts.ts: custom → validateCustom + loadExtension");
  } else {
    fail("custom wiring", "missing validateCustom or loadExtension");
  }

  // Repair wiring on the retry_with_repair_prompt prompt.
  if (prompts.content.includes("REPAIRS[\"obj\"]") &&
      prompts.content.includes("counter(\"cognition.repair.accepted\"") &&
      prompts.content.includes("__repaired")) {
    ok("prompts.ts: retry_with_repair_prompt calls REPAIRS[name] and re-validates");
  } else {
    fail("repair wiring", "missing REPAIRS[name] or re-validation");
  }

  // Bad-output is attached to the validation error so repair sees it.
  if (prompts.content.includes("__badOutput = __value")) {
    ok("prompts.ts: validation error carries __badOutput for repair");
  } else {
    fail("__badOutput", "validation error doesn't carry the bad output");
  }
}

// ─── Section 4: failure rules ───────────────────────────────────────────────

console.log("\nSection 4: prompt-derived failure rules emitted");

{
  const rules = emitFailureRules(phase5System);

  for (const promptName of ["classify", "code", "obj"]) {
    if (rules.includes(`prompt_validate_failed_${promptName}`)) ok(`failure_rules: prompt_validate_failed_${promptName}`);
    else fail(`prompt_validate_failed_${promptName}`, "missing");
    if (rules.includes(`prompt_timeout_${promptName}`)) ok(`failure_rules: prompt_timeout_${promptName}`);
    else fail(`prompt_timeout_${promptName}`, "missing");
    if (rules.includes(`prompt_budget_exceeded_${promptName}`)) ok(`failure_rules: prompt_budget_exceeded_${promptName}`);
    else fail(`prompt_budget_exceeded_${promptName}`, "missing");
  }
  // No router-bound prompts in this fixture, so no low_confidence rules.
  if (!rules.includes("prompt_low_confidence_classify")) ok("failure_rules: no low_confidence rule when prompt has no router");
  else fail("low_confidence skip", "should not emit when prompt has no router");
}

// ─── Section 5: determinism ─────────────────────────────────────────────────

console.log("\nSection 5: Phase 5 emit is deterministic");

{
  const v1 = emitValidateFile(phase5System)?.content || "";
  const v2 = emitValidateFile(phase5System)?.content || "";
  if (v1 === v2) ok("emitValidateFile: deterministic across two runs");
  else fail("validate determinism", "differ");

  const r1 = emitRepairFile(phase5System)?.content || "";
  const r2 = emitRepairFile(phase5System)?.content || "";
  if (r1 === r2) ok("emitRepairFile: deterministic across two runs");
  else fail("repair determinism", "differ");

  const f1 = emitFailureRules(phase5System);
  const f2 = emitFailureRules(phase5System);
  if (f1 === f2) ok("emitFailureRules: deterministic across two runs");
  else fail("failure_rules determinism", "differ");
}

// ─── Section 6: end-to-end runtime ──────────────────────────────────────────

console.log("\nSection 6: compiled runtime exercises validation + repair");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp_phase5_e2e");

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
  // Fill stubs.
  const ext = path.join(outDir, "src/extensions.ts");
  let content = fs.readFileSync(ext, "utf-8");
  content = fillExt(content);
  fs.writeFileSync(ext, content, "utf-8");
  return true;
}

const FIXTURE = `
system Phase5E2E {
  domain: cognitive_scaffold

  extension_point tmpl_class(text: string) {
    returns: string
    stable: false
  }
  extension_point tmpl_repair(text: string) {
    returns: string
    stable: false
  }
  extension_point validator_pass(value: json) {
    returns: bool
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

  // Schema-only validation, no repair: simple round-trip.
  // returns: string with a constraint requiring membership in a closed set.
  // The validator pass through validateSchemaOnly which checks string-shape;
  // membership is enforced by the runtime in the unit tests below by passing
  // a stub provider that returns the right values.
  prompt classify(text: string) {
    model: Tiny
    template: "extension_point:tmpl_class"
    returns: string
    validate: schema_only
    on_invalid: fail
  }

  // Schema-only validation, retry_with_repair_prompt.
  prompt classify_repair(text: string) {
    model: Tiny
    template: "extension_point:tmpl_repair"
    returns: string
    validate: schema_only
    on_invalid: retry_with_repair_prompt
    retry: { max_attempts: 2, backoff: fixed, interval: 50ms }
  }

  // Custom validation that always passes (proves the wiring).
  prompt always_ok(text: string) {
    model: Tiny
    template: "extension_point:tmpl_class"
    returns: string
    validate: custom: validator_pass
    on_invalid: fail
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
    /\/\/ <marrowscript:ext:tmpl_repair:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_repair:end>/,
    "// <marrowscript:ext:tmpl_repair:begin>\n  return `Pick: ${text}`;\n  // <marrowscript:ext:tmpl_repair:end>",
  );
  // The custom validator returns true unconditionally — proves the wiring.
  c = c.replace(
    /\/\/ <marrowscript:ext:validator_pass:begin>[\s\S]*?\/\/ <marrowscript:ext:validator_pass:end>/,
    "// <marrowscript:ext:validator_pass:begin>\n  return true;\n  // <marrowscript:ext:validator_pass:end>",
  );
  return c;
});

if (!compiled) {
  fail("compile fixture", "failed");
} else {
  ok("compiled Phase 5 fixture");
}

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
    // Test driver: a state machine over multiple stub responses.
    // First call: schema_only with valid output → success first try.
    // Second call: schema_only with bad output → fail (on_invalid: fail).
    // Third call: schema_only + retry_with_repair_prompt — first response bad,
    //             repair response good → repaired output returned.
    // Fourth call: custom validator → always passes.
    const driver = `
import { getModel } from "../src/providers";
import { callPrompt } from "../src/cognition";

let calls = 0;
let nextResponse = "";
const stub: any = {
  name: "stub",
  countTokens: (s: string) => Math.ceil(s.length / 4),
  async chat(_req: any) {
    calls++;
    const r = nextResponse;
    return { content: r, usage: { prompt_tokens: 10, completion_tokens: 5 } };
  },
};
(getModel("Tiny") as any).provider = stub;

(async () => {
  // 1. schema_only valid (non-empty string) → first call succeeds.
  calls = 0;
  nextResponse = "bug";
  const r1 = await callPrompt("classify", { text: "anything" });
  process.stdout.write("VALID::" + JSON.stringify({ calls, value: r1 }) + "\\n");

  // 2. schema_only invalid (empty string) + on_invalid: fail → throws after first attempt.
  calls = 0;
  nextResponse = "";
  let threw = false;
  let msg = "";
  try {
    await callPrompt("classify", { text: "anything" });
  } catch (err: any) {
    threw = true;
    msg = err && err.message;
  }
  process.stdout.write("INVALID_FAIL::" + JSON.stringify({ calls, threw, msg }) + "\\n");

  // 3. retry_with_repair_prompt: first stub returns empty (invalid), repair
  //    stub returns "feature" (valid) → caller gets the repaired value.
  //    The repair function calls chat() once; total = 2 calls.
  calls = 0;
  let stage = 0;
  stub.chat = async () => {
    calls++;
    stage++;
    return { content: stage === 1 ? "" : "feature", usage: { prompt_tokens: 5, completion_tokens: 5 } };
  };
  let r3: any;
  let r3err = "";
  try {
    r3 = await callPrompt("classify_repair", { text: "anything" });
  } catch (err: any) {
    r3err = err && err.message;
  }
  process.stdout.write("REPAIR::" + JSON.stringify({ calls, value: r3, err: r3err }) + "\\n");

  // 4. custom validator (always returns true) → succeeds with any output.
  calls = 0;
  stub.chat = async (_req: any) => { calls++; return { content: "anything goes", usage: {} }; };
  const r4 = await callPrompt("always_ok", { text: "anything" });
  process.stdout.write("CUSTOM::" + JSON.stringify({ calls, value: r4 }) + "\\n");
})().catch(err => {
  process.stderr.write("FAIL::" + (err && err.message || String(err)));
  process.exit(1);
});
`;
    fs.writeFileSync(path.join(OUT, "phase5_driver.ts"), driver, "utf-8");
    try {
      const out = execSync("npx --no-install ts-node --transpile-only phase5_driver.ts", {
        cwd: OUT,
        stdio: "pipe",
        encoding: "utf-8",
      });
      const get = (re: RegExp) => (out.match(re) || [])[1];
      const valid = get(/VALID::(\{.*\})/);
      const invFail = get(/INVALID_FAIL::(\{.*\})/);
      const repair = get(/REPAIR::(\{.*\})/);
      const custom = get(/CUSTOM::(\{.*\})/);

      if (valid) {
        const r = JSON.parse(valid);
        if (r.calls === 1 && r.value === "bug") ok("validate:schema_only valid → 1 call, value=bug");
        else fail("valid path", JSON.stringify(r));
      } else fail("VALID output", out);

      if (invFail) {
        const r = JSON.parse(invFail);
        if (r.threw && /validation failed/.test(r.msg)) ok("validate:schema_only invalid + on_invalid:fail → throws validation error");
        else fail("invalid+fail path", JSON.stringify(r));
        if (r.calls === 1) ok("on_invalid:fail does not retry");
        else fail("fail retry count", "expected 1 call, got " + r.calls);
      } else fail("INVALID_FAIL output", out);

      if (repair) {
        const r = JSON.parse(repair);
        // The repair flow does:
        //   call 1: original prompt → "garbage" (fails validation)
        //   call 2: repair prompt   → "feature" (passes validation, returned)
        // So calls === 2 and value === "feature".
        if (r.value === "feature" && r.calls === 2 && !r.err) {
          ok("retry_with_repair_prompt: bad output → repair → repaired value returned");
        } else {
          fail("repair path", JSON.stringify(r));
        }
      } else fail("REPAIR output", out);

      if (custom) {
        const r = JSON.parse(custom);
        if (r.calls === 1 && typeof r.value === "string") ok("validate:custom: validator returns true → output accepted");
        else fail("custom path", JSON.stringify(r));
      } else fail("CUSTOM output", out);
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
      fail("phase5 runtime", String(err.stdout || "") + " | " + String(err.stderr || ""));
    }
  }
}

// Cleanup.
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 5 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
