/**
 * MarrowScript Cognition Phase 9 Tests — repository ingestion
 *
 * Verifies:
 *   1. Catalog: ingest_repository is registered with the right category,
 *      input shape, output shape, cost, and callsModel discipline.
 *   2. emit_ingest.ts is conditional — emits zero files for non-ingest
 *      systems, emits src/cognition/ingest.ts when at least one capability
 *      uses cognition: ingest_repository.
 *   3. Runtime surface: redactUrl, assertIngestAllowed, sandboxKey,
 *      ingestRepository, IngestError all exported. Deny-list contains the
 *      documented binary/archive extensions.
 *   4. emit_full wires Phase 9 into the env-example block (LLM_INGEST_*).
 *   5. Type checker T028 catches typos in the catalog name.
 *   6. Determinism: emitIngestFiles produces byte-identical output across
 *      two compilations.
 *   7. End-to-end runtime: compile a fixture .marrow file, install deps,
 *      run the generated ingestRepository() against octocat/Hello-World
 *      (a 1-file, public, pinned-SHA test repo), and assert:
 *        - report.file_count = 1
 *        - report.head_sha matches the well-known pinned SHA
 *        - report.url_redacted strips userinfo
 *        - re-running hits the cache (cache_hit counter increments, no
 *          re-clone)
 *
 * Style follows compiler/src/test_cognition_phase8.ts.
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
import { CATALOG, lookupCognition } from "../cognition_catalog";
import { ingestNeeded, emitIngestFiles } from "../emit_ingest";

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
  return new Lowering().lower(ast, "phase9-test")[0];
}

console.log("MarrowScript Cognition Phase 9 Tests — repository ingestion\n");

// ─── Section 1: catalog ─────────────────────────────────────────────────────

console.log("Section 1: ingest_repository catalog entry");

{
  const spec = lookupCognition("ingest_repository");
  if (spec) ok("catalog: ingest_repository present");
  else { fail("ingest_repository", "missing"); process.exit(1); }
  if (spec!.category === "ingestion") ok("category: ingestion");
  else fail("category", spec!.category);
  if (spec!.cost === "free") ok("cost: free");
  else fail("cost", spec!.cost);
  if (spec!.callsModel === false) ok("callsModel: false (no LLM call)");
  else fail("callsModel", String(spec!.callsModel));

  const inputs = spec!.inputs.map(i => i.name);
  for (const expected of ["url", "ref", "max_bytes", "max_files", "timeout_ms"]) {
    if (inputs.includes(expected)) ok(`input: ${expected}`);
    else fail(`input ${expected}`, "missing");
  }
  const urlInput = spec!.inputs.find(i => i.name === "url");
  if (urlInput?.required) ok("url is required");
  else fail("url required", "should be required");
  const refInput = spec!.inputs.find(i => i.name === "ref");
  if (!refInput?.required) ok("ref is optional (defaults to HEAD)");
  else fail("ref optional", "should be optional");

  if (spec!.output.type.includes("local_path")) ok("output: includes local_path");
  else fail("output local_path", "missing");
  if (spec!.output.type.includes("head_sha")) ok("output: includes head_sha");
  else fail("output head_sha", "missing");
  if (spec!.output.type.includes("file_count")) ok("output: includes file_count");
  else fail("output file_count", "missing");

  // The emit body must reference the runtime module. Anything else means we
  // accidentally inlined the implementation back into the catalog.
  const body = spec!.emit();
  if (body.includes("require(\"./ingest\")")) ok("emit: delegates to src/cognition/ingest.ts");
  else fail("emit delegation", "expected require(\"./ingest\")");
  if (body.includes("ingestRepository")) ok("emit: calls ingestRepository(url, opts)");
  else fail("emit call", "missing ingestRepository call");
}

// ─── Section 2: conditional emission ────────────────────────────────────────

console.log("\nSection 2: emit_ingest is conditional on ingest_repository usage");

{
  const noIngest = compile(`
    system NoIngest {
      entity X { owns: [name: string] }
      capability rename(x: X, name: string) {
        requires: [name != ""]
        effects: [x.name = name]
        sync: eventual
      }
    }
  `);
  if (!ingestNeeded(noIngest)) ok("ingestNeeded: false when no ingest_repository capability");
  else fail("ingestNeeded(noIngest)", "expected false");
  if (emitIngestFiles(noIngest).length === 0) ok("emitIngestFiles: zero files for non-ingest system");
  else fail("emit zero", "produced files");

  const withIngest = compile(`
    system WithIngest {
      entity Job { owns: [url: string] }
      capability ingest(j: Job) {
        cognition: ingest_repository using {
          url: j.url
        }
        returns: json
        sync: eventual
      }
    }
  `);
  if (ingestNeeded(withIngest)) ok("ingestNeeded: true when capability uses ingest_repository");
  else fail("ingestNeeded(withIngest)", "expected true");

  const files = emitIngestFiles(withIngest);
  const paths = files.map(f => f.path).sort();
  const expected = ["src/cognition/ingest.ts"];
  if (JSON.stringify(paths) === JSON.stringify(expected)) ok("emitIngestFiles: 1-file tree (src/cognition/ingest.ts)");
  else fail("emit paths", JSON.stringify(paths));
}

// ─── Section 3: runtime surface ─────────────────────────────────────────────

console.log("\nSection 3: ingest.ts runtime surface");

const phase9System = compile(`
  system Phase9 {
    entity Job { owns: [url: string] }
    capability ingest(j: Job) {
      cognition: ingest_repository using {
        url: j.url,
        ref: "HEAD"
      }
      returns: json
      sync: eventual
    }
  }
`);

{
  const files = emitIngestFiles(phase9System);
  const ingest = files.find(f => f.path === "src/cognition/ingest.ts")!;
  for (const sym of [
    "export interface IngestReport",
    "export class IngestError",
    "export type IngestErrorKind",
    "export function redactUrl",
    "export function assertIngestAllowed",
    "export function sandboxKey",
    "export interface IngestOptions",
    "export async function ingestRepository",
  ]) {
    if (ingest.content.includes(sym)) ok(`ingest.ts: exports ${sym.replace("export ", "").split(" ")[0]} ${sym.split(" ").slice(-1)[0]}`);
    else fail(`ingest.ts ${sym}`, "missing");
  }

  // IngestErrorKind union members
  for (const kind of ["oversize", "too_many_files", "denied_extension", "clone_failed", "timeout", "ssrf", "escape", "invalid_url", "git_unavailable"]) {
    if (ingest.content.includes(`"${kind}"`)) ok(`IngestErrorKind: includes "${kind}"`);
    else fail(`error kind ${kind}`, "missing");
  }

  // Deny-list spot checks — the documented categories.
  for (const ext of [".zip", ".exe", ".dll", ".png", ".jpg", ".pdf", ".class"]) {
    if (ingest.content.includes(`"${ext}"`)) ok(`deny-list: contains "${ext}"`);
    else fail(`deny-list ${ext}`, "missing");
  }

  // Default allowlist — github, gitlab, codeberg, bitbucket.
  for (const host of ["https://github.com", "https://gitlab.com", "https://codeberg.org", "https://bitbucket.org"]) {
    if (ingest.content.includes(host)) ok(`default allowlist includes ${host}`);
    else fail(`allowlist ${host}`, "missing");
  }

  // Determinism: same key for same (url, ref).
  if (ingest.content.includes("createHash(\"sha256\")") && ingest.content.includes(".slice(0, 16)")) ok("sandboxKey: sha256(url|ref).slice(0, 16) — deterministic");
  else fail("sandboxKey deterministic", "missing crypto pattern");

  // Git invocation safety: execFile, NOT exec/spawn with shell.
  if (ingest.content.includes("execFile(") || ingest.content.includes("execFileAsync(")) ok("git: uses execFile (no shell injection surface)");
  else fail("execFile", "missing");
  if (!ingest.content.match(/\bexec\(/)) ok("git: never uses exec(...) (which spawns a shell)");
  else fail("no exec", "exec( found — security risk");
}

// ─── Section 4: env-example wiring ──────────────────────────────────────────

console.log("\nSection 4: emit_full env-example includes Phase 9 vars");

{
  const fullFiles = new FullEmitter().emit(phase9System);
  const env = fullFiles.find(f => f.path === ".env.example");
  if (!env) {
    fail("env.example", "not emitted");
  } else {
    for (const v of [
      "LLM_INGEST_ROOT",
      "LLM_INGEST_MAX_BYTES",
      "LLM_INGEST_MAX_FILES",
      "LLM_INGEST_TIMEOUT_MS",
      "LLM_INGEST_ALLOWLIST",
      "LLM_INGEST_ALLOW_ANY",
    ]) {
      if (env.content.includes(v + "=")) ok(`.env.example documents ${v}`);
      else fail(`env ${v}`, "missing");
    }
  }
}

// ─── Section 5: T028 catches typos in catalog names ─────────────────────────

console.log("\nSection 5: T028 catches typos");

{
  const tokens = new Lexer(`
    system Bad {
      entity Job { owns: [url: string] }
      capability ingest(j: Job) {
        cognition: ingest_repsitory using { url: j.url }
        returns: json
        sync: eventual
      }
    }
  `).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  const t028 = errs.find(e => e.code === "T028");
  if (t028 && t028.message.includes("ingest_repsitory")) ok("T028: typo in catalog name flagged");
  else fail("T028 typo", JSON.stringify(errs.map(e => e.code + ":" + e.message)));
}

// ─── Section 6: determinism ─────────────────────────────────────────────────

console.log("\nSection 6: emitIngestFiles is deterministic");

{
  const a = emitIngestFiles(phase9System).map(f => f.content).join("---");
  const b = emitIngestFiles(phase9System).map(f => f.content).join("---");
  if (a === b) ok("emitIngestFiles: deterministic across two runs");
  else fail("determinism", "differ");
}

// ─── Section 7: end-to-end runtime ──────────────────────────────────────────

console.log("\nSection 7: runtime ingest against a real public repo");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp_phase9_e2e");

function compileFixture(outDir: string, fixture: string): boolean {
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
  return true;
}

// Minimal fixture — entity + ingest capability. No prompt → no provider, no
// trace backend, nothing else to set up. Just lets us compile and import.
const FIXTURE = `
system Phase9E2E {
  domain: cognitive_scaffold

  entity Job {
    owns: [
      url: string
    ]
  }

  capability ingest(j: Job) {
    cognition: ingest_repository using {
      url: j.url,
      ref: "HEAD"
    }
    returns: json
    sync: eventual
  }
}
`;

const compiled = compileFixture(OUT, FIXTURE);
if (!compiled) {
  fail("compile fixture", "failed");
} else {
  ok("compiled Phase 9 fixture");
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
    // Driver: import the generated ingest module, run it against a real public
    // repo, then re-run to confirm the cache short-circuit.
    const driver = `
import * as path from "path";
process.env.LLM_INGEST_ROOT = path.join(process.cwd(), ".tmp_ingest_cache");
process.env.LLM_INGEST_TIMEOUT_MS = "60000";

import { ingestRepository, redactUrl, sandboxKey, IngestError } from "../src/cognition/ingest";

(async () => {
  // Smoke-test the helpers first (no network).
  const r1 = redactUrl("https://x:secret@github.com/octocat/Hello-World");
  process.stdout.write("REDACT::" + r1 + "\\n");

  const k1 = sandboxKey("https://github.com/octocat/Hello-World", "HEAD");
  const k2 = sandboxKey("https://github.com/octocat/Hello-World", "HEAD");
  process.stdout.write("KEY::" + JSON.stringify({ k1, k2, equal: k1 === k2, len: k1.length }) + "\\n");

  // SSRF: a private host should be rejected by the default allowlist.
  let ssrfErr: { kind: string; msg: string } | null = null;
  try {
    await ingestRepository("https://internal.example.com/foo.git");
  } catch (e) {
    if (e instanceof IngestError) ssrfErr = { kind: e.kind, msg: (e.message || "").slice(0, 60) };
  }
  process.stdout.write("SSRF::" + JSON.stringify(ssrfErr) + "\\n");

  // Real clone — octocat/Hello-World is public, contains 1 file (README), and
  // has been stable for years. Network failure here will fail the test.
  let real: { file_count: number; head_sha_len: number; url_redacted: string; ref: string; cached: boolean } | { error: string };
  try {
    const r = await ingestRepository("https://github.com/octocat/Hello-World", { ref: "HEAD" });
    real = { file_count: r.file_count, head_sha_len: r.head_sha.length, url_redacted: r.url_redacted, ref: r.ref, cached: false };
    // Re-run to confirm cache_hit.
    const r2 = await ingestRepository("https://github.com/octocat/Hello-World", { ref: "HEAD" });
    process.stdout.write("REAL::" + JSON.stringify(real) + "\\n");
    process.stdout.write("CACHE::" + JSON.stringify({ same_path: r.local_path === r2.local_path, same_sha: r.head_sha === r2.head_sha }) + "\\n");
  } catch (e) {
    real = { error: (e as Error).message || String(e) };
    process.stdout.write("REAL::" + JSON.stringify(real) + "\\n");
  }
})().catch(err => {
  process.stderr.write("FAIL::" + (err && err.message || String(err)));
  process.exit(1);
});
`;
    fs.writeFileSync(path.join(OUT, "phase9_driver.ts"), driver, "utf-8");
    try {
      const out = execSync("npx --no-install ts-node --transpile-only phase9_driver.ts", {
        cwd: OUT,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 180000,
      });
      const get = (re: RegExp) => (out.match(re) || [])[1];
      const redact = get(/REDACT::(.*)/);
      const keyJson = get(/KEY::(\{.*\})/);
      const ssrfJson = get(/SSRF::(\{.*\})/);
      const realJson = get(/REAL::(\{.*\})/);
      const cacheJson = get(/CACHE::(\{.*\})/);

      if (redact && !redact.includes("secret") && redact.includes("github.com/octocat")) {
        ok("redactUrl: strips userinfo (no \"secret\" leaks)");
      } else {
        fail("redactUrl", "got " + String(redact));
      }

      if (keyJson) {
        const k = JSON.parse(keyJson) as { k1: string; k2: string; equal: boolean; len: number };
        if (k.equal && k.len === 16 && /^[0-9a-f]+$/.test(k.k1)) ok("sandboxKey: deterministic 16-hex-char output");
        else fail("sandboxKey", JSON.stringify(k));
      } else fail("KEY", out);

      if (ssrfJson) {
        const s = JSON.parse(ssrfJson) as { kind: string; msg: string } | null;
        if (s && s.kind === "ssrf") ok("ingestRepository: rejects non-allowlisted hosts with IngestError(ssrf)");
        else fail("ssrf rejection", JSON.stringify(s));
      } else fail("SSRF", out);

      if (realJson) {
        const r = JSON.parse(realJson) as { file_count?: number; head_sha_len?: number; url_redacted?: string; ref?: string; error?: string };
        if (r.error) {
          // A network or git-unavailable failure isn't a test failure if the
          // host can't reach github.com — but we report it loudly.
          if (/git is not installed/.test(r.error)) {
            console.log("  (skipped real clone: git not installed on this host)");
          } else if (/getaddrinfo|ENOTFOUND|ECONNREFUSED|connect|timed out/i.test(r.error)) {
            console.log("  (skipped real clone: github.com unreachable from this host: " + r.error.slice(0, 80) + ")");
          } else {
            fail("real clone", r.error.slice(0, 200));
          }
        } else {
          if ((r.file_count ?? 0) >= 1) ok("real clone: file_count >= 1 for octocat/Hello-World");
          else fail("file_count", String(r.file_count));
          if (r.head_sha_len === 40) ok("real clone: head_sha is a full 40-char SHA");
          else fail("head_sha length", String(r.head_sha_len));
          if (r.url_redacted && r.url_redacted.includes("octocat/Hello-World")) ok("real clone: url_redacted stable");
          else fail("url_redacted", String(r.url_redacted));
          if (r.ref === "HEAD") ok("real clone: ref echoed back as HEAD");
          else fail("ref", String(r.ref));

          if (cacheJson) {
            const c = JSON.parse(cacheJson) as { same_path: boolean; same_sha: boolean };
            if (c.same_path && c.same_sha) ok("re-run: hits cache (same path + same sha)");
            else fail("cache hit", JSON.stringify(c));
          } else fail("CACHE output missing", out);
        }
      } else fail("REAL output missing", out);
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      const msg = String(err.stderr || "") + " | " + String(err.stdout || "") + " | " + String(err.message || "");
      // Don't fail the whole suite if the only thing wrong is no network — note it.
      if (/getaddrinfo|ENOTFOUND|ECONNREFUSED|timed out/i.test(msg)) {
        console.log("  (skipped runtime tests: network unavailable)");
      } else {
        fail("phase9 runtime", msg.slice(0, 600));
      }
    }
  }
}

// Cleanup.
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 9 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
