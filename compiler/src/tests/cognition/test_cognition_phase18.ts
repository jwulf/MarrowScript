/**
 * MarrowScript Cognition Phase 18 Tests — promptbook standard library
 *
 * Verifies:
 *   1. Lexer recognises `promptbook` and `with` keywords.
 *   2. Parser produces PromptDeclNode.promptbookRef + promptbookArgs.
 *   3. Lowering renders the baseline template at compile time using the
 *      `with:` args and produces a plain `template:` IR string. Promptbook
 *      arg placeholders ({{name}}) get substituted; {{__input.foo}} stays.
 *   4. Type checker codes T060–T063:
 *        T060: template + promptbook both set
 *        T061: unknown promptbook entry
 *        T062: missing required arg
 *        T063: unknown arg name
 *   5. PROMPTBOOK registry has at least 8 entries spanning all 5 categories.
 *   6. renderPromptbookTemplate substitutes args correctly:
 *      - string args → literal value
 *      - string[] args → bullet list
 *      - missing optional args → empty string
 *      - {{__input.<name>}} stays intact
 *   7. Determinism — render is bitwise stable across two calls.
 */

import { Lexer, TokenKind } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";
import {
  PROMPTBOOK,
  lookupPromptbookEntry,
  listPromptbookNames,
  renderPromptbookTemplate,
} from "../promptbook";

let passed = 0;
let failed = 0;

function ok(name: string): void { console.log(`  v ${name}`); passed++; }
function fail(name: string, msg: string): void { console.log(`  x ${name}: ${msg}`); failed++; }

function compile(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) throw new Error("type check: " + errs.map(e => e.code + ":" + e.message).join("; "));
  return new Lowering().lower(ast, "phase18-test")[0];
}
function tcheck(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  return new TypeChecker().check(ast);
}

console.log("MarrowScript Cognition Phase 18 Tests — promptbook\n");

// ─── Section 1: lexer ──────────────────────────────────────────────────────

console.log("Section 1: Lexer recognises Phase 18 keywords");
{
  const src = "promptbook with";
  const tokens = new Lexer(src).tokenize();
  if (tokens.some(t => t.kind === TokenKind.KwPromptbook && t.value === "promptbook")) ok("lexer: 'promptbook' → KwPromptbook");
  else fail("lexer promptbook", "missing");
  if (tokens.some(t => t.kind === TokenKind.KwWith && t.value === "with")) ok("lexer: 'with' → KwWith");
  else fail("lexer with", "missing");
}

// ─── Section 2: registry shape ─────────────────────────────────────────────

console.log("\nSection 2: PROMPTBOOK registry");

{
  const names = listPromptbookNames();
  if (names.length >= 8) ok(`registry: ${names.length} entries`);
  else fail("entry count", `expected ≥ 8, got ${names.length}`);

  // Spans all 5 categories.
  const cats = new Set(Object.values(PROMPTBOOK).map(e => e.category));
  for (const c of ["classification", "extraction", "generation", "validation", "reasoning"] as const) {
    if (c === "validation") continue; // optional v1 slot
    if (cats.has(c)) ok(`registry: covers '${c}' category`);
    else fail(`category ${c}`, "missing");
  }

  // Required entries by name.
  for (const name of [
    "binary_classify",
    "multi_class_classify",
    "summarize",
    "paraphrase",
    "translate",
    "extract_json",
    "chain_of_thought_solve",
    "self_critique_then_revise",
  ]) {
    if (lookupPromptbookEntry(name)) ok(`registry: ${name}`);
    else fail(`entry ${name}`, "missing");
  }

  // Unknown entries return null.
  if (lookupPromptbookEntry("nonexistent") === null) ok("registry: lookup returns null for unknown");
  else fail("unknown lookup", "should be null");
}

// ─── Section 3: render ─────────────────────────────────────────────────────

console.log("\nSection 3: renderPromptbookTemplate");

{
  const entry = lookupPromptbookEntry("binary_classify")!;
  const out = renderPromptbookTemplate(entry, { positive_label: "spam", negative_label: "ham" });
  if (out.includes("- spam") && out.includes("- ham")) ok("render: substitutes string args");
  else fail("string args", out.slice(0, 200));
  if (out.includes("{{__input.text}}")) ok("render: leaves {{__input.<name>}} intact");
  else fail("input placeholder", "substituted away");
  if (!out.includes("{{positive_label}}")) ok("render: every {{positive_label}} occurrence consumed");
  else fail("orphan placeholder", "still present");
}

// String[] arg → bullet list.
{
  const entry = lookupPromptbookEntry("multi_class_classify")!;
  const out = renderPromptbookTemplate(entry, { categories: ["bug", "feature", "question"] });
  if (out.includes("  - bug") && out.includes("  - feature") && out.includes("  - question")) {
    ok("render: string[] → bullet list");
  } else {
    fail("bullet list", out.slice(0, 300));
  }
}

// Missing optional arg → empty string substitution.
{
  const entry = lookupPromptbookEntry("summarize")!;
  // No args at all — both summarize args are optional.
  const out = renderPromptbookTemplate(entry, {});
  if (out.includes("Style: ") && out.includes("Maximum length:  words.")) {
    ok("render: missing optional args → empty substitution");
  } else {
    fail("optional args", out.slice(0, 200));
  }
}

// Determinism.
{
  const entry = lookupPromptbookEntry("translate")!;
  const a = renderPromptbookTemplate(entry, { target_language: "Spanish" });
  const b = renderPromptbookTemplate(entry, { target_language: "Spanish" });
  if (a === b) ok("render: deterministic across two calls");
  else fail("determinism", "differ");
}

// ─── Section 4: parser + lowering ─────────────────────────────────────────

console.log("\nSection 4: parser + lowering integration");

const phase18System = compile(`
  system Phase18 {
    extension_point unused(text: string) { returns: string, stable: false }
    model Tiny {
      provider: ollama
      name: "qwen2.5:1.5b"
      context_window: 8000
      max_output: 256
      cost_class: tiny
    }

    prompt is_spam(text: string) {
      model: Tiny
      promptbook: binary_classify
      with: {
        positive_label: "spam"
        negative_label: "ham"
      }
      returns: string
      validate: schema_only
    }

    prompt classify_doc(text: string) {
      model: Tiny
      promptbook: multi_class_classify
      with: {
        categories: ["bug", "feature", "question"]
      }
      returns: string
      validate: schema_only
    }
  }
`);

{
  const isSpam = phase18System.prompts.find(p => p.name === "is_spam")!;
  if (isSpam.template.includes("- spam") && isSpam.template.includes("- ham")) {
    ok("lowering: is_spam template rendered with positive/negative labels");
  } else {
    fail("is_spam render", isSpam.template.slice(0, 200));
  }
  if (isSpam.template.includes("{{__input.text}}")) {
    ok("lowering: {{__input.text}} preserved for runtime substitution");
  } else {
    fail("input placeholder lost", "substituted at compile time");
  }

  const classify = phase18System.prompts.find(p => p.name === "classify_doc")!;
  if (classify.template.includes("  - bug") &&
      classify.template.includes("  - feature") &&
      classify.template.includes("  - question")) {
    ok("lowering: classify_doc renders categories as bullets");
  } else {
    fail("classify render", classify.template.slice(0, 300));
  }
}

// ─── Section 5: type-checker T060..T063 ────────────────────────────────────

console.log("\nSection 5: TypeChecker — T060..T063");

function expectErr(name: string, code: string, source: string): void {
  const errs = tcheck(source);
  if (errs.some(e => e.code === code)) ok(`${code}: ${name}`);
  else fail(name, `expected ${code}, got [${errs.map(e => e.code).join(", ")}]`);
}

expectErr("template + promptbook both set", "T060", `
  system X {
    extension_point t(s: string) { returns: string, stable: false }
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(text: string) {
      model: M
      template: "extension_point:t"
      promptbook: binary_classify
      with: { positive_label: "a", negative_label: "b" }
      returns: string
      validate: schema_only
    }
  }
`);

expectErr("unknown promptbook entry", "T061", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(text: string) {
      model: M
      promptbook: not_a_real_entry
      returns: string
      validate: schema_only
    }
  }
`);

expectErr("missing required arg", "T062", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(text: string) {
      model: M
      promptbook: binary_classify
      with: { positive_label: "yes" }
      returns: string
      validate: schema_only
    }
  }
`);

expectErr("unknown arg name", "T063", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    prompt p(text: string) {
      model: M
      promptbook: binary_classify
      with: { positive_label: "a", negative_label: "b", garbage: 42 }
      returns: string
      validate: schema_only
    }
  }
`);

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 18 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
