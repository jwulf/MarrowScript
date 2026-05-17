/**
 * MarrowScript Cognition Phase 3 Tests — caching + budget
 *
 * Verifies the Phase 3 additions:
 *   1. Compiler emits src/cognition/{budget,cache}.ts and migrations/prompt_cache.sql
 *      only when at least one prompt declares cache: (and cognition is in use).
 *   2. The generated prompt body wires cache.get → cache.put around the
 *      provider call.
 *   3. The generated prompt body wires budget.assertCanSpend → budget.charge
 *      around the provider call.
 *   4. End-to-end: a stub provider call counts as 1; a second call with
 *      identical input is served from cache (counter = 1, returns same value).
 *   5. End-to-end: a budget ceiling smaller than the request rejects with
 *      BudgetExceededError before the provider is touched.
 *
 * Style follows compiler/src/test_cognition_emit.ts and
 * compiler/src/test_cognition_e2e.ts.
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
import { emitBudget } from "../emit_budget";
import { emitCacheFiles, anyPromptUsesCache } from "../emit_cache";
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
  return new Lowering().lower(ast, "phase3-test")[0];
}

console.log("MarrowScript Cognition Phase 3 Tests — caching + budget\n");

// ─── Section 1: file emission ────────────────────────────────────────────────

console.log("Section 1: Phase 3 files are conditional on cache: usage");

{
  // Cognition with cache → cache files emitted.
  const withCache = compile(`
    system WithCache {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) {
        model: M
        template: "extension_point:t"
        returns: string
        cache: { key: hash(x), ttl: 1h }
      }
    }
  `);
  if (anyPromptUsesCache(withCache)) ok("anyPromptUsesCache: true when cache: declared");
  else fail("anyPromptUsesCache", "expected true");

  const cacheFiles = emitCacheFiles(withCache);
  const paths = cacheFiles.map(f => f.path).sort();
  if (JSON.stringify(paths) === JSON.stringify(["migrations/prompt_cache.sql", "src/cognition/cache.ts"])) {
    ok("emitCacheFiles: emits schema + runtime");
  } else {
    fail("emitCacheFiles", JSON.stringify(paths));
  }

  const schema = cacheFiles.find(f => f.path.endsWith(".sql"))!;
  if (schema.content.includes("CREATE TABLE IF NOT EXISTS prompt_cache") &&
      schema.content.includes("cache_key       VARCHAR(64) PRIMARY KEY") &&
      schema.content.includes("expires_at      TIMESTAMPTZ NOT NULL") &&
      schema.content.includes("idx_prompt_cache_expires")) {
    ok("prompt_cache.sql: shape correct");
  } else {
    fail("prompt_cache.sql", "missing required columns / indexes");
  }

  const runtime = cacheFiles.find(f => f.path.endsWith("cache.ts"))!;
  if (runtime.content.includes("class MemoryCache") &&
      runtime.content.includes("class PgCache") &&
      runtime.content.includes("LLM_CACHE_MODE") &&
      runtime.content.includes("export function deriveKey")) {
    ok("cache.ts: memory + pg backends + deriveKey export");
  } else {
    fail("cache.ts", "missing backends or deriveKey");
  }

  // Cognition without cache → no cache files.
  const noCache = compile(`
    system NoCache {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) {
        model: M
        template: "extension_point:t"
        returns: string
      }
    }
  `);
  if (!anyPromptUsesCache(noCache)) ok("anyPromptUsesCache: false when no cache: declared");
  else fail("anyPromptUsesCache", "expected false");
  if (emitCacheFiles(noCache).length === 0) ok("emitCacheFiles: zero files when no cache: declared");
  else fail("emitCacheFiles", "unexpected files");

  // Budget always emits when cognition exists.
  const budget = emitBudget(withCache);
  if (budget && budget.path === "src/cognition/budget.ts") ok("emitBudget: src/cognition/budget.ts");
  else fail("emitBudget", JSON.stringify(budget?.path));
  if (budget && budget.content.includes("BudgetExceededError") &&
      budget.content.includes("LLM_BUDGET_TOKENS_PER_TRACE") &&
      budget.content.includes("LLM_BUDGET_USD_PER_TRACE")) {
    ok("budget.ts: BudgetExceededError + both env vars");
  } else {
    fail("budget.ts", "missing surface");
  }

  // No cognition at all → no budget either.
  const noCognition = compile(`
    system Plain {
      entity X { owns: [name: string] }
      capability rename(x: X, name: string) {
        requires: [name != ""]
        effects: [x.name = name]
        sync: eventual
      }
    }
  `);
  if (emitBudget(noCognition) === null) ok("emitBudget: null when no cognition");
  else fail("emitBudget", "should be null");
}

// ─── Section 2: prompt body wiring ───────────────────────────────────────────

console.log("\nSection 2: Generated prompt body wires cache + budget correctly");

const phase3System = compile(`
  system Phase3 {
    extension_point tmpl_classify(text: string) { returns: string, stable: false }
    extension_point tmpl_plain(text: string) { returns: string, stable: false }

    model Tiny {
      provider: ollama
      name: "qwen2.5:1.5b"
      context_window: 32000
      max_output: 256
      cost_class: tiny
      latency_class: fast
    }

    prompt cached_classify(text: string) {
      model: Tiny
      template: "extension_point:tmpl_classify"
      returns: string
      timeout: 5s
      validate: schema_only
      cache: { key: hash(text), ttl: 1h }
    }

    prompt uncached_classify(text: string) {
      model: Tiny
      template: "extension_point:tmpl_plain"
      returns: string
      timeout: 5s
      validate: schema_only
    }

    policy harness {
      rate_limit: 60 per 1m
      audit: true
    }
  }
`);

{
  const files = emitCognitionFiles(phase3System);
  const prompts = files.find(f => f.path === "src/cognition/prompts.ts")!;

  // Cache wiring on cached prompt only.
  if (prompts.content.includes("await cache.get(__cacheKey)") &&
      prompts.content.includes("await cache.put(__cacheKey")) {
    ok("prompts.ts: cache.get + cache.put wired for cached prompts");
  } else {
    fail("cache wiring", "missing cache.get or cache.put");
  }

  // Budget wiring is unconditional (every prompt gets a tracker, free unless env limits set).
  if (prompts.content.includes("__budget.assertCanSpend(__estimatedTokens, __model.costClass)") &&
      prompts.content.includes("__budget.charge(__actualTokens || __estimatedTokens, __model.costClass)")) {
    ok("prompts.ts: assertCanSpend + charge wired");
  } else {
    fail("budget wiring", "missing assertCanSpend or charge");
  }

  // BudgetExceededError is terminal.
  if (prompts.content.includes("if (__err instanceof BudgetExceededError)") &&
      prompts.content.includes("error_code: \"BUDGET_EXCEEDED\"")) {
    ok("prompts.ts: BudgetExceededError bypasses retry");
  } else {
    fail("budget terminal", "missing instanceof BudgetExceededError branch");
  }

  // The uncached prompt must NOT have cache lines, but MUST have budget lines.
  // Find the section between `prompt_uncached_classify` and the next prompt boundary.
  const uncachedStart = prompts.content.indexOf("async function prompt_uncached_classify(");
  // Find the next async function definition after uncached_classify.
  const tail = prompts.content.slice(uncachedStart + 1);
  const nextFn = tail.indexOf("async function prompt_");
  const uncachedSection = tail.slice(0, nextFn === -1 ? tail.length : nextFn);
  if (!uncachedSection.includes("await cache.get") && !uncachedSection.includes("await cache.put")) {
    ok("prompts.ts: uncached prompt has NO cache calls");
  } else {
    fail("uncached cache", "uncached prompt has cache calls");
  }
  if (uncachedSection.includes("__budget.assertCanSpend") && uncachedSection.includes("__budget.charge")) {
    ok("prompts.ts: uncached prompt still has budget");
  } else {
    fail("uncached budget", "uncached prompt missing budget");
  }

  // Cache key derivation embeds the user-supplied hash(text) expression.
  if (prompts.content.includes('createHash("sha256").update(String(input["text"]')) {
    ok("prompts.ts: user key expr 'hash(text)' lowered to crypto hash of input.text");
  } else {
    fail("user key expr", "hash(text) didn't lower to createHash on input.text");
  }
}

// ─── Section 3: determinism ──────────────────────────────────────────────────

console.log("\nSection 3: Phase 3 emit is deterministic");

{
  const a1 = emitCognitionFiles(phase3System).map(f => f.content).join("---");
  const a2 = emitCognitionFiles(phase3System).map(f => f.content).join("---");
  if (a1 === a2) ok("emitCognitionFiles: deterministic across two runs");
  else fail("cognition determinism", "two runs differ");

  const c1 = emitCacheFiles(phase3System).map(f => f.content).join("---");
  const c2 = emitCacheFiles(phase3System).map(f => f.content).join("---");
  if (c1 === c2) ok("emitCacheFiles: deterministic across two runs");
  else fail("cache determinism", "two runs differ");

  const b1 = emitBudget(phase3System)?.content || "";
  const b2 = emitBudget(phase3System)?.content || "";
  if (b1 === b2) ok("emitBudget: deterministic across two runs");
  else fail("budget determinism", "two runs differ");
}

// ─── Section 4: end-to-end runtime behaviour ────────────────────────────────

console.log("\nSection 4: Compiled runtime behaviour");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp_phase3_e2e");

function compileFixture(outDir: string, fixture: string): boolean {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const tokens = new Lexer(fixture).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) return false;
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
  // Fill the extension stubs with trivial implementations.
  let extContent = fs.readFileSync(path.join(outDir, "src/extensions.ts"), "utf-8");
  extContent = extContent.replace(
    /\/\/ <marrowscript:ext:tmpl_classify:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_classify:end>/,
    "// <marrowscript:ext:tmpl_classify:begin>\n  return `Classify: ${text}`;\n  // <marrowscript:ext:tmpl_classify:end>",
  );
  extContent = extContent.replace(
    /\/\/ <marrowscript:ext:tmpl_plain:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_plain:end>/,
    "// <marrowscript:ext:tmpl_plain:begin>\n  return `Plain: ${text}`;\n  // <marrowscript:ext:tmpl_plain:end>",
  );
  fs.writeFileSync(path.join(outDir, "src/extensions.ts"), extContent, "utf-8");
  return true;
}

const FIXTURE = `
system Phase3E2E {
  domain: cognitive_scaffold

  extension_point tmpl_classify(text: string) {
    returns: string
    stable: false
  }
  extension_point tmpl_plain(text: string) {
    returns: string
    stable: false
  }

  model Tiny {
    provider: ollama
    name: "qwen2.5:1.5b"
    context_window: 32000
    max_output: 256
    cost_class: tiny
    latency_class: fast
  }

  prompt cached_classify(text: string) {
    model: Tiny
    template: "extension_point:tmpl_classify"
    returns: string
    timeout: 5s
    validate: schema_only
    cache: { key: hash(text), ttl: 1h }
  }

  prompt uncached_classify(text: string) {
    model: Tiny
    template: "extension_point:tmpl_plain"
    returns: string
    timeout: 5s
    validate: schema_only
  }

  policy harness {
    rate_limit: 60 per 1m
    audit: true
  }
}
`;

const compiled = compileFixture(OUT, FIXTURE);
if (!compiled) {
  fail("compile fixture", "failed");
} else {
  ok("compiled Phase 3 fixture");
}

if (compiled) {
  // Install deps once, mirroring test_cognition_e2e.ts.
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
    // Driver: replace the provider with a counting stub. Hit the cached prompt
    // twice with the same input — the second call must be a cache hit (counter = 1).
    // Then hit the uncached prompt twice with the same input — both must reach the stub (counter = 2).
    const cacheDriver = `
import { getModel } from "../src/providers";
import { callPrompt } from "../src/cognition";
import { __resetMemoryCache } from "../src/cognition/cache";

let calls = 0;
const stub: any = {
  name: "stub",
  countTokens: (s: string) => Math.ceil(s.length / 4),
  async chat(req: any) {
    calls++;
    return {
      content: "OUTPUT::" + req.messages[0].content.slice(0, 32),
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  },
};
const tiny = getModel("Tiny");
(tiny as any).provider = stub;

(async () => {
  __resetMemoryCache();

  const r1 = await callPrompt("cached_classify", { text: "hello" });
  const r2 = await callPrompt("cached_classify", { text: "hello" });
  process.stdout.write("CACHED::" + JSON.stringify({ calls, r1, r2 }) + "\\n");

  calls = 0;
  const r3 = await callPrompt("uncached_classify", { text: "hello" });
  const r4 = await callPrompt("uncached_classify", { text: "hello" });
  process.stdout.write("UNCACHED::" + JSON.stringify({ calls, r3, r4 }) + "\\n");

  // Different input on cached prompt should miss the cache.
  __resetMemoryCache();
  calls = 0;
  await callPrompt("cached_classify", { text: "hello" });
  await callPrompt("cached_classify", { text: "world" });
  process.stdout.write("CACHE_MISS::" + JSON.stringify({ calls }) + "\\n");
})().catch(err => {
  process.stderr.write("FAIL::" + (err && err.message || String(err)));
  process.exit(1);
});
`;
    fs.writeFileSync(path.join(OUT, "phase3_cache_driver.ts"), cacheDriver, "utf-8");
    try {
      const out = execSync("npx --no-install ts-node --transpile-only phase3_cache_driver.ts", {
        cwd: OUT,
        stdio: "pipe",
        encoding: "utf-8",
      });
      const cached = (out.match(/CACHED::(\{.*\})/) || [])[1];
      const uncached = (out.match(/UNCACHED::(\{.*\})/) || [])[1];
      const miss = (out.match(/CACHE_MISS::(\{.*\})/) || [])[1];

      if (cached) {
        const c = JSON.parse(cached);
        if (c.calls === 1) ok("cached prompt: provider called exactly once for two identical inputs");
        else fail("cached calls", `expected 1, got ${c.calls}`);
        if (c.r1 === c.r2) ok("cached prompt: both calls returned the same value");
        else fail("cached values", JSON.stringify(c));
      } else {
        fail("cached output", out);
      }
      if (uncached) {
        const u = JSON.parse(uncached);
        if (u.calls === 2) ok("uncached prompt: provider called twice (no caching)");
        else fail("uncached calls", `expected 2, got ${u.calls}`);
      } else {
        fail("uncached output", out);
      }
      if (miss) {
        const m = JSON.parse(miss);
        if (m.calls === 2) ok("cached prompt: different inputs miss the cache");
        else fail("cache miss calls", `expected 2, got ${m.calls}`);
      } else {
        fail("cache miss output", out);
      }
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
      fail("cache runtime", String(err.stdout || "") + " | " + String(err.stderr || ""));
    }

    // Budget driver: set a tiny token budget, expect BudgetExceededError before
    // the provider is touched.
    const budgetDriver = `
import { getModel } from "../src/providers";
import { callPrompt } from "../src/cognition";

// Set a token budget that any normal prompt would exceed.
process.env.LLM_BUDGET_TOKENS_PER_TRACE = "5";

let calls = 0;
const stub: any = {
  name: "stub",
  countTokens: (s: string) => Math.ceil(s.length / 4),
  async chat(req: any) {
    calls++;
    return { content: "X", usage: { prompt_tokens: 10, completion_tokens: 5 } };
  },
};
const tiny = getModel("Tiny");
(tiny as any).provider = stub;

(async () => {
  let threw = false;
  let code = "";
  try {
    await callPrompt("uncached_classify", { text: "this is some text that should bust the budget" });
  } catch (err: any) {
    threw = true;
    code = err && err.code;
  }
  process.stdout.write("BUDGET::" + JSON.stringify({ calls, threw, code }) + "\\n");
})().catch(err => {
  process.stderr.write("FAIL::" + (err && err.message || String(err)));
  process.exit(1);
});
`;
    fs.writeFileSync(path.join(OUT, "phase3_budget_driver.ts"), budgetDriver, "utf-8");
    try {
      // We need to read the env var at module load — ts-node loads the budget
      // module once, so we set the env in the driver before any import.
      // The compiled budget module reads env at module init. To make this work
      // in a single ts-node run, we re-require by spawning a fresh subprocess
      // that has the env already set.
      const out = execSync("npx --no-install ts-node --transpile-only phase3_budget_driver.ts", {
        cwd: OUT,
        stdio: "pipe",
        encoding: "utf-8",
        env: { ...process.env, LLM_BUDGET_TOKENS_PER_TRACE: "5" },
      });
      const m = (out.match(/BUDGET::(\{.*\})/) || [])[1];
      if (m) {
        const r = JSON.parse(m);
        if (r.threw && r.code === "BUDGET_EXCEEDED") ok("budget: throws BudgetExceededError when ceiling exceeded");
        else fail("budget threw", JSON.stringify(r));
        if (r.calls === 0) ok("budget: provider NOT called when ceiling exceeded");
        else fail("budget pre-empt", `provider was called ${r.calls} times`);
      } else {
        fail("budget output", out);
      }
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
      fail("budget runtime", String(err.stdout || "") + " | " + String(err.stderr || ""));
    }
  }
}

// Cleanup.
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 3 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
