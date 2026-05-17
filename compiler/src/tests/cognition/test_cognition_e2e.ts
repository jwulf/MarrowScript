/**
 * MarrowScript Cognition Phase 2 End-to-End Smoke Test
 *
 * Compiles a representative .marrow fixture into a fresh output directory,
 * fills in the stable extension_point bodies with trivial implementations,
 * runs `tsc --noEmit` on the generated tree, and asserts:
 *
 *   1. The full FullEmitter pipeline produces the cognition + provider tree
 *      (src/cognition/*.ts and src/providers/*.ts).
 *   2. The generated TypeScript type-checks cleanly under strict mode.
 *   3. A subsequent compilation produces bitwise-identical output (the
 *      compiler-level determinism guarantee includes Phase 2 artifacts).
 *   4. The cognition runtime can be imported and prompt callers can be
 *      invoked against a stub IModelProvider, returning the expected shape.
 *
 * Skipped automatically if `node_modules/typescript` is unavailable in the
 * generated output (matches the test_react / test_prisma pattern).
 *
 * Style follows compiler/src/test_react.ts and compiler/src/test_prisma.ts.
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

console.log("MarrowScript Cognition Phase 2 — End-to-End Smoke Test\n");

// ─── Fixture .marrow source ───────────────────────────────────────────────────

const FIXTURE = `
system Phase2E2E {
  domain: cognitive_scaffold

  entity Doc {
    owns: [
      title: string,
      body: string
    ]
  }

  store DocStore {
    engine: postgresql
    schema: {
      id: uuid,
      title: string,
      body: string,
      created_at: timestamp,
      updated_at: timestamp
    }
  }

  // Templates declared with stable: false so missing impls don't error out;
  // we fill them with trivial bodies before running tsc.
  extension_point tmpl_classify(text: string) {
    returns: string
    stable: false
  }

  extension_point tmpl_summarize(body: string, max_tokens: uint) {
    returns: string
    stable: false
  }

  model Tiny {
    provider: ollama
    name: "qwen2.5:1.5b"
    context_window: 32000
    max_output: 512
    cost_class: tiny
    latency_class: fast
  }

  model Big {
    provider: openai_compat
    endpoint: "http://localhost:8080/v1"
    name: "phi-3.5-mini"
    context_window: 128000
    max_output: 2048
    cost_class: small
    latency_class: medium
  }

  router by_size {
    by: input.length
    tier short { max: 1000 -> Tiny }
    tier rest  { -> Big }
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
    model: Tiny
    template: "extension_point:tmpl_classify"
    returns: string
    timeout: 5s
    validate: schema_only
    retry: { max_attempts: 2, backoff: fixed, interval: 200ms }
    tools: [ping]
  }

  prompt summarize(body: string, max_tokens: uint) {
    router: by_size
    template: "extension_point:tmpl_summarize"
    returns: string
    timeout: 30s
    validate: schema_only
    on_invalid: escalate
  }

  capability summarise_doc(d: Doc) {
    cognition: compress_context using {
      history: d.body,
      target_tokens: 512
    }
    returns: string
    sync: eventual
  }

  // Phase 17: a small flow with a checkpoint so the e2e suite exercises
  // emit_checkpoint.ts (migrations/flow_runs.sql, src/flows/checkpoints.ts,
  // src/routes/flow_runs.ts) under strict-mode tsc.
  capability begin_review(d: Doc) {
    requires: [d.body != ""]
    sync: eventual
    idempotent: true
  }
  capability finalize_review(d: Doc) {
    requires: [d.body != ""]
    sync: eventual
    idempotent: true
  }

  flow review_with_pause {
    step open: begin_review(d)
      checkpoint: review_plan {
        shows: [d.body]
        allow: ["approve", "reject"]
        timeout: 1h
        on_timeout: cancel
      }
    step close: finalize_review(d)
  }

  policy harness {
    rate_limit: 60 per 1m
    audit: true
  }

  // Phase 16: a small evaluation fixture so the e2e suite exercises the
  // generated runner + index + CLI under strict-mode tsc.
  evaluation classify_quality {
    prompt: classify
    cases: [
      {
        name: "smoke"
        input: { text: "hello world" }
        expected: {
          passes: schema_only
          must_contain_string: ["hello"]
          max_lines: 50
        }
      }
    ]
    metric: pass_rate
    baseline: { min_pass_rate: 0.5 }
    schedule: { on: ["pre_commit"] }
  }
}
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function compileFixture(outDir: string): { ok: boolean; fileCount: number; ext: string | null } {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const tokens = new Lexer(FIXTURE).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) {
    return { ok: false, fileCount: 0, ext: null };
  }
  const sourceHash = createHash("sha256").update(FIXTURE).digest("hex").slice(0, 16);
  const irSystems = new Lowering().lower(ast, sourceHash);
  const solver = new ConstraintSolver();
  for (const sys of irSystems) {
    const result = solver.solve(sys);
    sys.resolution = result.resolution;
  }
  const files = new FullEmitter().emit(irSystems[0]);
  let ext: string | null = null;
  for (const f of files) {
    const full = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, "utf-8");
    if (f.path === "src/extensions.ts") ext = f.content;
  }
  return { ok: true, fileCount: files.length, ext };
}

function fillExtensionStubs(outDir: string): void {
  // Replace the stable: false stubs with trivial implementations so the
  // generated runtime compiles. The cognition layer reads templates by name
  // via require("../extensions"), so we need the function bodies to exist.
  const filePath = path.join(outDir, "src/extensions.ts");
  let content = fs.readFileSync(filePath, "utf-8");
  content = content.replace(
    /\/\/ <marrowscript:ext:tmpl_classify:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_classify:end>/,
    `// <marrowscript:ext:tmpl_classify:begin>
  return \`Classify the following text into one of: bug, feature, question.\\n\\n\${text}\`;
  // <marrowscript:ext:tmpl_classify:end>`,
  );
  content = content.replace(
    /\/\/ <marrowscript:ext:tmpl_summarize:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_summarize:end>/,
    `// <marrowscript:ext:tmpl_summarize:begin>
  return \`Summarize in <= \${max_tokens} tokens:\\n\\n\${body}\`;
  // <marrowscript:ext:tmpl_summarize:end>`,
  );
  fs.writeFileSync(filePath, content, "utf-8");
}

function npmInstallIfNeeded(outDir: string): boolean {
  const nm = path.join(outDir, "node_modules");
  if (fs.existsSync(nm)) return true;
  console.log("  (installing project deps — first run only)");
  try {
    execSync("npm install --no-audit --no-fund --silent", { cwd: outDir, stdio: "pipe" });
    return true;
  } catch (e) {
    console.log("  (npm install failed — skipping tsc check)");
    return false;
  }
}

function runTsc(outDir: string): { ok: boolean; output: string } {
  try {
    const out = execSync("npx --no-install tsc --noEmit -p tsconfig.json", {
      cwd: outDir,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return { ok: true, output: String(out) };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    const out = String(err.stdout || "") + String(err.stderr || "");
    return { ok: false, output: out };
  }
}

// ─── 1. Compile the fixture ─────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp_phase2_e2e");
console.log("Step 1: Compile the fixture .marrow file");
const compileResult = compileFixture(OUT);
if (compileResult.ok) ok(`compiled fixture: ${compileResult.fileCount} files emitted to ${path.basename(OUT)}/`);
else { fail("compile", "type check or lowering failed"); process.exit(1); }

// ─── 2. Generated tree contains the cognition layer ─────────────────────────

console.log("\nStep 2: Generated tree includes cognition + providers");

const expectedFiles = [
  "src/cognition/index.ts",
  "src/cognition/router.ts",
  "src/cognition/prompts.ts",
  "src/cognition/primitives.ts",
  "src/providers/types.ts",
  "src/providers/ssrf_guard.ts",
  "src/providers/ollama.ts",
  "src/providers/openai_compat.ts",
  "src/providers/index.ts",
  "src/extensions.ts",
];
for (const rel of expectedFiles) {
  const full = path.join(OUT, rel);
  if (fs.existsSync(full)) ok(`${rel} emitted`);
  else fail(rel, "missing");
}

// .env.example carries the cognition env vars block.
const envExample = fs.readFileSync(path.join(OUT, ".env.example"), "utf-8");
if (envExample.includes("Cognition Layer (LLM Harness, Phase 2)") &&
    envExample.includes("LLM_ENDPOINT_ALLOWLIST") &&
    envExample.includes("OLLAMA_HOST")) {
  ok(".env.example: cognition env vars block present");
} else {
  fail(".env.example", "cognition block missing");
}

// ─── 3. tsc --noEmit on the generated tree ─────────────────────────────────

console.log("\nStep 3: tsc --noEmit on the generated tree");
fillExtensionStubs(OUT);
const installed = npmInstallIfNeeded(OUT);
if (!installed) {
  console.log("  (skipping tsc check — see install message above)");
} else {
  const tsc = runTsc(OUT);
  if (tsc.ok) {
    ok("generated TypeScript type-checks cleanly under strict mode");
  } else {
    fail("tsc --noEmit", "compilation failed:\n" + tsc.output.slice(0, 4000));
  }
}

// ─── 4. Determinism (full pipeline including cognition) ─────────────────────

console.log("\nStep 4: Two compilations are bitwise identical");

function hashCognitionTree(dir: string): string {
  const parts: string[] = [];
  const files = [
    "src/cognition/index.ts",
    "src/cognition/router.ts",
    "src/cognition/prompts.ts",
    "src/cognition/primitives.ts",
    "src/providers/types.ts",
    "src/providers/ssrf_guard.ts",
    "src/providers/ollama.ts",
    "src/providers/openai_compat.ts",
    "src/providers/index.ts",
  ];
  for (const f of files.sort()) {
    parts.push(f + "\n" + fs.readFileSync(path.join(dir, f), "utf-8"));
  }
  return createHash("sha256").update(parts.join("\n---\n")).digest("hex").slice(0, 16);
}

const hash1 = hashCognitionTree(OUT);
const SECOND = path.join(ROOT, "tmp_phase2_e2e_second");
const second = compileFixture(SECOND);
if (!second.ok) {
  fail("determinism", "second compile failed");
} else {
  const hash2 = hashCognitionTree(SECOND);
  if (hash1 === hash2) ok(`both compilations match (hash=${hash1})`);
  else fail("determinism", `hash1=${hash1} hash2=${hash2}`);
}

// ─── 5. Cognition runtime imports & is callable with a stub provider ───────

console.log("\nStep 5: Runtime imports + stub-provider call");

if (installed) {
  // Build a small driver that injects a stub provider, calls the classify
  // prompt, and prints the result. The stub returns a known string so we can
  // assert on it without needing a live model server.
  const driverSrc = `
import { getModel } from "../src/providers";
import { callPrompt } from "../src/cognition";

const stub: any = {
  name: "stub",
  countTokens: (s: string) => Math.ceil(s.length / 4),
  async chat(req: any) {
    return { content: "STUB::" + req.messages[0].content.slice(0, 32), usage: {} };
  },
};
// Patch the model entry the way a test harness would.
const entry = getModel("Tiny");
(entry as any).provider = stub;

(async () => {
  const out = await callPrompt("classify", { text: "hello world" });
  process.stdout.write("RESULT::" + JSON.stringify(out));
})().catch(err => {
  process.stderr.write("FAIL::" + (err && err.message || String(err)));
  process.exit(1);
});
`;
  const driverPath = path.join(OUT, "phase2_smoke.ts");
  fs.writeFileSync(driverPath, driverSrc, "utf-8");
  try {
    const out = execSync("npx --no-install ts-node --transpile-only phase2_smoke.ts", {
      cwd: OUT,
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (out.includes("RESULT::") && out.includes("STUB::")) {
      ok("classify prompt invoked end-to-end with a stub provider; returned the stub's content");
    } else {
      fail("runtime invocation", `unexpected output: ${out.slice(0, 200)}`);
    }
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    fail("runtime invocation", String(err.stdout || "") + " | " + String(err.stderr || ""));
  }
}

// ─── Cleanup tmp dirs ───────────────────────────────────────────────────────

try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.join(ROOT, "tmp_phase2_e2e_second"), { recursive: true, force: true }); } catch {}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 2 E2E results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
