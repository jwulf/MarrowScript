/**
 * MarrowScript Cognition Phase 10 Tests — per-repo retrieval filtering
 *
 * Verifies:
 *   1. SQL schema gains repo_id columns + idx_*_repo indexes.
 *   2. types.ts exports RepoFilter and Symbol/etc carry repo_id.
 *   3. retriever.ts walkIndex accepts an optional repo_filter argument.
 *   4. memory/index.ts InProcessIndex threads repo_filter through to walkIndex.
 *   5. cognition_catalog's semantic_slice declares the optional `repos` input.
 *   6. bin/index_sources.ts exposes a --repo-id flag.
 *   7. Determinism — emitMemoryFiles is bitwise stable across runs.
 *   8. End-to-end: build a tiny two-fixture index where each fixture is
 *      tagged with a different repo_id, then walk with a filter and assert
 *      only the matching repo's files come back.
 *
 * Style follows compiler/src/test_cognition_phase9.ts.
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
import { emitMemoryFiles } from "../emit_memory";
import { lookupCognition } from "../cognition_catalog";

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
  return new Lowering().lower(ast, "phase10-test")[0];
}

console.log("MarrowScript Cognition Phase 10 Tests — per-repo retrieval filtering\n");

// A fixture system that uses semantic_slice so the memory layer is emitted.
const phase10System = compile(`
  system Phase10 {
    entity Job { owns: [task: string] }
    capability slice(j: Job) {
      cognition: semantic_slice using {
        task: j.task,
        max_files: 8,
        hop_depth: 2
      }
      returns: json
      sync: eventual
    }
  }
`);

// ─── Section 1: schema + indexes ────────────────────────────────────────────

console.log("Section 1: semantic_index.sql carries repo_id");

{
  const files = emitMemoryFiles(phase10System);
  const sql = files.find(f => f.path === "migrations/semantic_index.sql")!;
  // repo_id column in every fact table.
  for (const tbl of ["symbols", "imports", "calls", "file_summaries"]) {
    if (sql.content.match(new RegExp("CREATE TABLE IF NOT EXISTS " + tbl + "[\\s\\S]*?repo_id"))) {
      ok(`sql: ${tbl} has repo_id column`);
    } else fail(`sql ${tbl}.repo_id`, "missing");
  }
  // Indexes on repo_id for retrieval filter.
  for (const idx of ["idx_symbols_repo", "idx_imports_repo", "idx_calls_repo"]) {
    if (sql.content.includes(idx)) ok(`sql: ${idx} index present`);
    else fail(`sql ${idx}`, "missing");
  }
  // file_summaries gets a composite primary key including repo_id.
  if (sql.content.match(/file_summaries[\s\S]*?PRIMARY KEY \(repo_id, file\)/)) {
    ok("sql: file_summaries primary key includes repo_id");
  } else fail("file_summaries pk", "missing repo_id in primary key");
}

// ─── Section 2: types.ts surface ────────────────────────────────────────────

console.log("\nSection 2: types.ts surface");

{
  const files = emitMemoryFiles(phase10System);
  const types = files.find(f => f.path === "src/memory/types.ts")!;
  for (const sym of [
    "export type RepoFilter",
    "repo_id: string",
    "walk(task: string, hopDepth: number, maxFiles: number, repo_filter?: RepoFilter)",
  ]) {
    if (types.content.includes(sym)) ok(`types.ts: ${sym.slice(0, 60)}`);
    else fail(`types.ts ${sym.slice(0, 40)}`, "missing");
  }
}

// ─── Section 3: retriever wiring ────────────────────────────────────────────

console.log("\nSection 3: retriever.ts threads the filter");

{
  const files = emitMemoryFiles(phase10System);
  const retr = files.find(f => f.path === "src/memory/retriever.ts")!;
  for (const tok of [
    "repo_filter?: RepoFilter",
    "fileAllowed",
    "Phase 10",
    "if (!fileAllowed(",
  ]) {
    if (retr.content.includes(tok)) ok(`retriever: ${tok.slice(0, 60)}`);
    else fail(`retriever ${tok}`, "missing");
  }
}

// ─── Section 4: memory/index.ts InProcessIndex.walk ─────────────────────────

console.log("\nSection 4: InProcessIndex.walk threads the filter");

{
  const files = emitMemoryFiles(phase10System);
  const idx = files.find(f => f.path === "src/memory/index.ts")!;
  if (idx.content.includes("walk(task: string, hopDepth: number, maxFiles: number, repo_filter?: RepoFilter)")) {
    ok("memory/index.ts: walk signature includes repo_filter");
  } else fail("memory/index.ts walk", "signature mismatch");
  if (idx.content.includes("walkIndex(r, task, hopDepth, maxFiles, repo_filter)")) {
    ok("memory/index.ts: walk passes repo_filter through to walkIndex");
  } else fail("memory/index.ts walk passthrough", "missing");
}

// ─── Section 5: cognition catalog input ─────────────────────────────────────

console.log("\nSection 5: semantic_slice catalog declares `repos` input");

{
  const spec = lookupCognition("semantic_slice");
  if (!spec) { fail("semantic_slice", "missing from catalog"); process.exit(1); }
  const reposInput = spec!.inputs.find(i => i.name === "repos");
  if (reposInput) ok("catalog: semantic_slice has `repos` input");
  else fail("catalog repos input", "missing");
  if (reposInput && !reposInput.required) ok("catalog: `repos` is optional");
  else fail("repos required", "should be optional");
  // The emit body should pass repoFilter through to walk().
  const body = spec!.emit();
  if (body.includes("repoFilter") && body.includes("walk(task, hopDepth, maxFiles, repoFilter)")) {
    ok("catalog: emit body threads repoFilter to index.walk()");
  } else fail("emit body", "missing repoFilter wiring");
}

// ─── Section 6: bin/index_sources.ts --repo-id flag ─────────────────────────

console.log("\nSection 6: bin/index_sources.ts exposes --repo-id");

{
  const files = emitMemoryFiles(phase10System);
  const bin = files.find(f => f.path === "bin/index_sources.ts")!;
  for (const tok of [
    "--repo-id",
    "let repo_id =",
    "buildIndex(root, undefined, repo_id)",
  ]) {
    if (bin.content.includes(tok)) ok(`indexer: ${tok}`);
    else fail(`indexer ${tok}`, "missing");
  }
}

// ─── Section 7: determinism ─────────────────────────────────────────────────

console.log("\nSection 7: emitMemoryFiles deterministic");

{
  const a = emitMemoryFiles(phase10System).map(f => f.content).join("---");
  const b = emitMemoryFiles(phase10System).map(f => f.content).join("---");
  if (a === b) ok("emitMemoryFiles: bitwise identical across two runs");
  else fail("determinism", "differ");
}

// ─── Section 8: end-to-end runtime filter ───────────────────────────────────

console.log("\nSection 8: runtime walk respects the repo filter");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp_phase10_e2e");

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

const FIXTURE = `
system Phase10E2E {
  domain: cognitive_scaffold

  entity Job { owns: [task: string] }

  capability slice(j: Job) {
    cognition: semantic_slice using {
      task: j.task,
      max_files: 8,
      hop_depth: 2
    }
    returns: json
    sync: eventual
  }
}
`;

const compiled = compileFixture(OUT, FIXTURE);
if (!compiled) fail("compile fixture", "failed");
else ok("compiled Phase 10 fixture");

if (compiled) {
  // Build two tiny fixture trees that the indexer can walk: repo-a has
  // login/auth-shaped symbols, repo-b has billing-shaped symbols. We tag
  // each tree with a different repo_id and verify that the walk only
  // returns files from the requested repo.
  const repoARoot = path.join(OUT, "fixture_repo_a");
  const repoBRoot = path.join(OUT, "fixture_repo_b");
  fs.mkdirSync(repoARoot, { recursive: true });
  fs.mkdirSync(repoBRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoARoot, "auth.ts"),
    "export function loginUser(name: string): boolean { return name.length > 0; }\nexport class SessionStore { read(k: string) { return k; } }\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(repoARoot, "crypto.ts"),
    "import { createHash } from 'crypto';\nexport function hashPassword(p: string): string { return createHash('sha256').update(p).digest('hex'); }\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(repoBRoot, "billing.ts"),
    "export class Invoice { total: number = 0; }\nexport function chargeCard(id: string, amount: number): boolean { return amount > 0; }\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(repoBRoot, "stripe.ts"),
    "export interface StripeClient { create(): Promise<void>; }\nexport function newStripeClient(): StripeClient { return { create: async () => {} }; }\n",
    "utf-8",
  );

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
    const driver = `
import { buildIndex } from "../src/memory/semantic_index";
import { walkIndex } from "../src/memory/retriever";
import * as path from "path";

const repoARoot = ${JSON.stringify(repoARoot)};
const repoBRoot = ${JSON.stringify(repoBRoot)};

const idxA = buildIndex(repoARoot, undefined, "repo-a");
const idxB = buildIndex(repoBRoot, undefined, "repo-b");

// Merge the two indexes by combining maps. This is the simplest cross-repo
// store — production deployments would use the pg backend instead, but the
// in-process merge is enough to prove the filter works.
const merged = {
  files: [...idxA.files, ...idxB.files],
  symbolsByFile: new Map([...idxA.symbolsByFile, ...idxB.symbolsByFile]),
  importsByFile: new Map([...idxA.importsByFile, ...idxB.importsByFile]),
  reverseImports: new Map([...idxA.reverseImports, ...idxB.reverseImports]),
  fileSummaries: new Map([...idxA.fileSummaries, ...idxB.fileSummaries]),
};

const sliceUnfiltered = walkIndex(merged, "user login authentication", 2, 8);
const sliceA = walkIndex(merged, "user login authentication", 2, 8, "repo-a");
const sliceB = walkIndex(merged, "billing invoice charge", 2, 8, "repo-b");
const sliceArr = walkIndex(merged, "user login authentication", 2, 8, ["repo-a", "repo-b"]);

process.stdout.write("UNFILTERED::" + JSON.stringify({ files: sliceUnfiltered.files }) + "\\n");
process.stdout.write("FILTERED_A::" + JSON.stringify({ files: sliceA.files }) + "\\n");
process.stdout.write("FILTERED_B::" + JSON.stringify({ files: sliceB.files }) + "\\n");
process.stdout.write("FILTERED_BOTH::" + JSON.stringify({ files: sliceArr.files }) + "\\n");
`;
    fs.writeFileSync(path.join(OUT, "phase10_driver.ts"), driver, "utf-8");
    try {
      const out = execSync("npx --no-install ts-node --transpile-only phase10_driver.ts", {
        cwd: OUT,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 60000,
      });
      const get = (re: RegExp) => (out.match(re) || [])[1];
      const u = get(/UNFILTERED::(\{.*\})/);
      const a = get(/FILTERED_A::(\{.*\})/);
      const b = get(/FILTERED_B::(\{.*\})/);
      const both = get(/FILTERED_BOTH::(\{.*\})/);

      // The merge should make all files reachable when no filter is set.
      if (u) {
        const r = JSON.parse(u) as { files: string[] };
        if (r.files.includes("auth.ts")) ok("unfiltered walk: includes auth.ts (from merged repo-a)");
        else fail("unfiltered auth.ts", JSON.stringify(r.files));
      } else fail("UNFILTERED output", out);

      // Filter to repo-a — should ONLY contain repo-a files.
      if (a) {
        const r = JSON.parse(a) as { files: string[] };
        const containsAuth = r.files.includes("auth.ts");
        const containsBilling = r.files.some(f => f.startsWith("billing"));
        if (containsAuth) ok("filter='repo-a': includes auth.ts");
        else fail("filter repo-a auth.ts", JSON.stringify(r.files));
        if (!containsBilling) ok("filter='repo-a': excludes billing.ts (from repo-b)");
        else fail("filter repo-a excludes b", JSON.stringify(r.files));
      } else fail("FILTERED_A output", out);

      // Filter to repo-b — should ONLY contain repo-b files.
      if (b) {
        const r = JSON.parse(b) as { files: string[] };
        const containsBilling = r.files.includes("billing.ts");
        const containsAuth = r.files.some(f => f.startsWith("auth"));
        if (containsBilling) ok("filter='repo-b': includes billing.ts");
        else fail("filter repo-b billing.ts", JSON.stringify(r.files));
        if (!containsAuth) ok("filter='repo-b': excludes auth.ts (from repo-a)");
        else fail("filter repo-b excludes a", JSON.stringify(r.files));
      } else fail("FILTERED_B output", out);

      // Array filter — both repos.
      if (both) {
        const r = JSON.parse(both) as { files: string[] };
        if (r.files.includes("auth.ts")) ok("filter=['repo-a','repo-b']: includes both repos' files (e.g. auth.ts)");
        else fail("filter array auth.ts", JSON.stringify(r.files));
      } else fail("FILTERED_BOTH output", out);
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      const msg = String(err.stderr || "") + " | " + String(err.stdout || "") + " | " + String(err.message || "");
      fail("phase10 runtime", msg.slice(0, 600));
    }
  }
}

// Cleanup.
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 10 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
