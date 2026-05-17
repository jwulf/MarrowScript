/**
 * MarrowScript Cognition Phase 4 Tests — memory layer
 *
 * Verifies the Phase 4 additions:
 *   1. Compiler emits src/memory/*.ts and migrations/semantic_index.sql only
 *      when at least one capability uses semantic_slice or compress_context.
 *   2. The runtime symbol extractor parses a small TypeScript fixture and
 *      pulls out the right symbols + import edges.
 *   3. The retriever performs a deterministic BFS from a task-keyword seed
 *      and returns a small slice (never the whole repo).
 *   4. End-to-end: a generated cognition runtime can call semantic_slice
 *      against the indexed source tree and get a non-empty slice.
 *
 * Style follows compiler/src/test_cognition_phase3.ts.
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
import { emitMemoryFiles, memoryNeeded } from "../emit_memory";
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
  return new Lowering().lower(ast, "phase4-test")[0];
}

console.log("MarrowScript Cognition Phase 4 Tests — memory layer\n");

// ─── Section 1: conditional file emission ───────────────────────────────────

console.log("Section 1: emitMemoryFiles is conditional on memory primitives");

{
  // System WITHOUT semantic_slice / compress_context → no memory files.
  const noMemory = compile(`
    system NoMemory {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) { model: M, template: "extension_point:t", returns: string }
    }
  `);
  if (!memoryNeeded(noMemory)) ok("memoryNeeded: false when no memory primitives used");
  else fail("memoryNeeded(noMemory)", "expected false");
  if (emitMemoryFiles(noMemory).length === 0) ok("emitMemoryFiles: zero files for non-memory system");
  else fail("emitMemoryFiles(noMemory)", "unexpected files");

  // System WITH semantic_slice → full memory tree.
  const withSlice = compile(`
    system WithSlice {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) { model: M, template: "extension_point:t", returns: string }
      entity Doc { owns: [body: string] }
      capability slice(d: Doc) {
        cognition: semantic_slice using { task: d.body, max_files: 8, hop_depth: 2 }
        returns: json
        sync: eventual
      }
    }
  `);
  if (memoryNeeded(withSlice)) ok("memoryNeeded: true when capability uses semantic_slice");
  else fail("memoryNeeded(withSlice)", "expected true");

  const files = emitMemoryFiles(withSlice);
  const paths = files.map(f => f.path).sort();
  const expected = [
    "bin/index_sources.ts",
    "migrations/semantic_index.sql",
    "src/memory/compressor.ts",
    "src/memory/index.ts",
    "src/memory/retriever.ts",
    "src/memory/semantic_index.ts",
    "src/memory/types.ts",
  ];
  if (JSON.stringify(paths) === JSON.stringify(expected)) {
    ok("emitMemoryFiles: emits the documented 7-file tree");
  } else {
    fail("emitMemoryFiles file set", JSON.stringify(paths));
  }

  // System WITH compress_context (no semantic_slice) → still emits memory.
  const withCompress = compile(`
    system WithCompress {
      extension_point t(x: string) { returns: string, stable: false }
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      prompt p(x: string) { model: M, template: "extension_point:t", returns: string }
      entity Doc { owns: [body: string] }
      capability compress(d: Doc) {
        cognition: compress_context using { history: d.body, target_tokens: 512 }
        returns: json
        sync: eventual
      }
    }
  `);
  if (memoryNeeded(withCompress)) ok("memoryNeeded: true when capability uses compress_context");
  else fail("memoryNeeded(withCompress)", "expected true");
  if (emitMemoryFiles(withCompress).length === 7) ok("emitMemoryFiles: 7 files for compress_context system");
  else fail("emitMemoryFiles compress count", String(emitMemoryFiles(withCompress).length));
}

// ─── Section 2: schema + runtime shape ──────────────────────────────────────

console.log("\nSection 2: Generated artifacts have the expected shape");

const phase4System = compile(`
  system Phase4 {
    extension_point tmpl_pick(task: string) { returns: string, stable: false }

    model Tiny { provider: ollama, name: "qwen2.5:1.5b", context_window: 8000, max_output: 256, cost_class: tiny }

    prompt pick(task: string) {
      model: Tiny
      template: "extension_point:tmpl_pick"
      returns: string
    }

    entity Doc { owns: [body: string] }

    capability pick_files(d: Doc) {
      cognition: semantic_slice using { task: d.body, max_files: 4, hop_depth: 2 }
      returns: json
      sync: eventual
    }

    policy harness {
      rate_limit: 60 per 1m
      audit: true
    }
  }
`);

{
  const files = emitMemoryFiles(phase4System);
  const schema = files.find(f => f.path === "migrations/semantic_index.sql")!;
  if (schema.content.includes("CREATE TABLE IF NOT EXISTS symbols") &&
      schema.content.includes("CREATE TABLE IF NOT EXISTS imports") &&
      schema.content.includes("CREATE TABLE IF NOT EXISTS calls") &&
      schema.content.includes("CREATE TABLE IF NOT EXISTS file_summaries") &&
      schema.content.includes("CREATE TABLE IF NOT EXISTS task_anchors")) {
    ok("semantic_index.sql: 5 graph tables present");
  } else {
    fail("semantic_index schema", "missing one of the expected tables");
  }

  const types = files.find(f => f.path === "src/memory/types.ts")!;
  if (types.content.includes("export interface Symbol") &&
      types.content.includes("export interface SemanticSlice") &&
      types.content.includes("export interface SemanticIndex") &&
      // The walk signature gained an optional Phase 10 repo_filter parameter,
      // so we only check for the prefix up to maxFiles — the closing form
      // moved from `): SemanticSlice` to `, repo_filter?: RepoFilter): SemanticSlice`.
      types.content.includes("walk(task: string, hopDepth: number, maxFiles: number")) {
    ok("types.ts: shared Symbol / SemanticSlice / SemanticIndex contracts present");
  } else {
    fail("types.ts surface", "missing one of Symbol / SemanticSlice / SemanticIndex");
  }

  const idx = files.find(f => f.path === "src/memory/semantic_index.ts")!;
  if (idx.content.includes("function buildIndex(") &&
      idx.content.includes("function listSourceFiles(") &&
      idx.content.includes("function extractFile(") &&
      idx.content.includes("function deriveSymbolId(") &&
      idx.content.includes("function loadTypescript(")) {
    ok("semantic_index.ts: indexer surface (build/list/extract/derive/loadTS)");
  } else {
    fail("semantic_index.ts surface", "missing one of buildIndex/listSourceFiles/extractFile/deriveSymbolId/loadTypescript");
  }
  if (idx.content.includes("extractWithTypescript") && idx.content.includes("extractWithRegex")) {
    ok("semantic_index.ts: TS AST + regex fallback both emitted");
  } else {
    fail("symbol extraction strategies", "missing one of TS / regex");
  }

  const retriever = files.find(f => f.path === "src/memory/retriever.ts")!;
  if (retriever.content.includes("export function walkIndex(") &&
      retriever.content.includes("function tokenise(") &&
      retriever.content.includes("function splitIdent(") &&
      retriever.content.includes("function scoreSymbol(") &&
      retriever.content.includes("STOPWORDS")) {
    ok("retriever.ts: keyword tokeniser + scorer + walkIndex");
  } else {
    fail("retriever.ts surface", "missing one of walkIndex/tokenise/scoreSymbol/STOPWORDS");
  }

  const compressor = files.find(f => f.path === "src/memory/compressor.ts")!;
  if (compressor.content.includes("export function compressSlice(") &&
      compressor.content.includes("CompressedSlice")) {
    ok("compressor.ts: compressSlice + CompressedSlice");
  } else {
    fail("compressor.ts surface", "missing compressSlice");
  }

  const memIndex = files.find(f => f.path === "src/memory/index.ts")!;
  if (memIndex.content.includes("export function getIndex()") &&
      memIndex.content.includes("class InProcessIndex") &&
      memIndex.content.includes("LLM_MEMORY_ROOT") &&
      memIndex.content.includes("export async function sliceForPrompt(")) {
    ok("memory/index.ts: getIndex + InProcessIndex + LLM_MEMORY_ROOT + sliceForPrompt");
  } else {
    fail("memory/index.ts surface", "missing one of getIndex/InProcessIndex/LLM_MEMORY_ROOT/sliceForPrompt");
  }

  // Cognition layer should now wire memory.getIndex() in CognitionCtx.
  const cogFiles = emitCognitionFiles(phase4System);
  const primitives = cogFiles.find(f => f.path === "src/cognition/primitives.ts")!;
  if (primitives.content.includes("memory: {") &&
      primitives.content.includes("getIndex():")) {
    ok("primitives.ts: CognitionCtx exposes memory.getIndex()");
  } else {
    fail("primitives ctx", "missing memory.getIndex slot");
  }
  const cogIndex = cogFiles.find(f => f.path === "src/cognition/index.ts")!;
  if (cogIndex.content.includes("import { getIndex as __getMemoryIndex } from \"../memory\"") &&
      cogIndex.content.includes("getIndex() { return __getMemoryIndex(); }")) {
    ok("cognition/index.ts: buildCtx wires memory.getIndex when memory is in use");
  } else {
    fail("cognition wiring", "missing memory wire-up");
  }
  // The semantic_slice primitive falls back to ctx.memory.getIndex().
  if (primitives.content.includes("ctx.memory.getIndex()") &&
      primitives.content.includes("source: \"index\"")) {
    ok("primitives.ts: semantic_slice falls back to ctx.memory.getIndex()");
  } else {
    fail("semantic_slice fallback", "primitive should call ctx.memory.getIndex");
  }
}

// ─── Section 3: determinism ─────────────────────────────────────────────────

console.log("\nSection 3: emit_memory output is deterministic");

{
  const a = emitMemoryFiles(phase4System).map(f => f.content).join("---");
  const b = emitMemoryFiles(phase4System).map(f => f.content).join("---");
  if (a === b) ok("emitMemoryFiles: deterministic across two runs");
  else fail("memory determinism", "two runs differ");
}

// ─── Section 4: end-to-end (compile + index + walk) ─────────────────────────

console.log("\nSection 4: Compiled runtime can index a fixture and serve a slice");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tmp_phase4_e2e");

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
  // Fill stub.
  const ext = path.join(outDir, "src/extensions.ts");
  let extContent = fs.readFileSync(ext, "utf-8");
  extContent = extContent.replace(
    /\/\/ <marrowscript:ext:tmpl_pick:begin>[\s\S]*?\/\/ <marrowscript:ext:tmpl_pick:end>/,
    "// <marrowscript:ext:tmpl_pick:begin>\n  return `Pick files for: ${task}`;\n  // <marrowscript:ext:tmpl_pick:end>",
  );
  fs.writeFileSync(ext, extContent, "utf-8");
  return true;
}

const FIXTURE = `
system Phase4E2E {
  domain: cognitive_scaffold

  extension_point tmpl_pick(task: string) {
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

  prompt pick(task: string) {
    model: Tiny
    template: "extension_point:tmpl_pick"
    returns: string
  }

  entity Doc { owns: [body: string] }

  capability pick_files(d: Doc) {
    cognition: semantic_slice using { task: d.body, max_files: 4, hop_depth: 2 }
    returns: json
    sync: eventual
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
  ok("compiled Phase 4 fixture");
}

if (compiled) {
  // Make a tiny indexable corpus inside the project so the symbol extractor
  // has something to chew on. The retriever should later find these by keyword.
  const fixtureSrc = path.join(OUT, "fixture_src");
  fs.mkdirSync(fixtureSrc, { recursive: true });
  fs.writeFileSync(path.join(fixtureSrc, "auth.ts"),
    `// Authentication helpers
import { hashPassword } from "../crypto";
export function loginUser(email: string, password: string): boolean {
  return checkPassword(email, password);
}
export class SessionStore {
  validate(token: string): boolean { return token.length > 0; }
}
function checkPassword(email: string, pw: string): boolean { return hashPassword(pw) !== ""; }
`, "utf-8");
  fs.writeFileSync(path.join(fixtureSrc, "crypto.ts"),
    `// Cryptographic helpers
export function hashPassword(input: string): string {
  return "h:" + input;
}
export function signToken(claims: object): string { return JSON.stringify(claims); }
`, "utf-8");
  fs.writeFileSync(path.join(fixtureSrc, "feed.ts"),
    `// Activity feed — unrelated to auth.
export interface FeedItem { id: string; ts: number; }
export function publishItem(item: FeedItem): void { /* ... */ }
export function listRecent(limit: number): FeedItem[] { return []; }
`, "utf-8");

  // Install + run a smoke driver. We exercise:
  //   1. buildIndex picks up all 3 files.
  //   2. The TS extractor finds loginUser, hashPassword, etc.
  //   3. walkIndex on "user login authentication" returns auth.ts first
  //      and pulls crypto.ts in via the import edge.
  //   4. semantic_slice cognition primitive returns the same shape via
  //      the cognition runtime.
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
import * as path from "path";
process.env.LLM_MEMORY_ROOT = path.join(process.cwd(), "fixture_src");

import { buildIndex } from "../src/memory/semantic_index";
import { walkIndex } from "../src/memory/retriever";
import { getIndex } from "../src/memory";
import { runCognition } from "../src/cognition";

(async () => {
  // 1. Direct index build.
  const idx = buildIndex(process.env.LLM_MEMORY_ROOT!);
  process.stdout.write("FILES::" + JSON.stringify(idx.files.sort()) + "\\n");

  // 2. Symbols in auth.ts.
  const authSyms = idx.symbolsByFile.get("auth.ts") || [];
  const names = authSyms.map(s => s.name).sort();
  process.stdout.write("AUTH_SYMS::" + JSON.stringify(names) + "\\n");

  // 3. Walk.
  const slice = walkIndex(idx, "user login authentication", 2, 4);
  process.stdout.write("SLICE::" + JSON.stringify(slice) + "\\n");

  // 4. Walk through cognition runtime (uses ctx.memory.getIndex()).
  const r = await runCognition("semantic_slice", { task: "user login authentication", max_files: 4, hop_depth: 2 });
  process.stdout.write("COG_SLICE::" + JSON.stringify(r) + "\\n");

  // 5. Determinism: walk twice with the same input → identical result.
  const slice2 = walkIndex(idx, "user login authentication", 2, 4);
  process.stdout.write("DETERMINISM::" + (JSON.stringify(slice) === JSON.stringify(slice2)) + "\\n");

  // 6. Empty repo via different keyword: ensure unrelated keyword still gives a slice (target_symbol may be empty).
  const empty = walkIndex(idx, "completely unrelated nonsense words", 2, 4);
  process.stdout.write("EMPTY::" + JSON.stringify({ files: empty.files, symbols: empty.symbols.length }) + "\\n");

  // 7. Singleton: getIndex() returns the same instance and its walk works.
  const handle = getIndex();
  const handleSlice = handle.walk("login", 2, 4);
  process.stdout.write("HANDLE::" + JSON.stringify({ files: handleSlice.files, symbols: handleSlice.symbols.length }) + "\\n");
})().catch(err => {
  process.stderr.write("FAIL::" + (err && err.message || String(err)));
  process.exit(1);
});
`;
    fs.writeFileSync(path.join(OUT, "phase4_driver.ts"), driver, "utf-8");
    try {
      const out = execSync("npx --no-install ts-node --transpile-only phase4_driver.ts", {
        cwd: OUT,
        stdio: "pipe",
        encoding: "utf-8",
      });
      const get = (re: RegExp) => (out.match(re) || [])[1];
      const filesJson = get(/FILES::(\[.*\])/);
      const authJson = get(/AUTH_SYMS::(\[.*\])/);
      const sliceJson = get(/SLICE::(\{.*\})/);
      const cogJson = get(/COG_SLICE::(\{.*\})/);
      const det = get(/DETERMINISM::(true|false)/);
      const emptyJson = get(/EMPTY::(\{.*\})/);
      const handleJson = get(/HANDLE::(\{.*\})/);

      if (filesJson) {
        const files = JSON.parse(filesJson) as string[];
        if (files.includes("auth.ts") && files.includes("crypto.ts") && files.includes("feed.ts")) {
          ok("buildIndex picked up all 3 fixture files");
        } else {
          fail("buildIndex files", JSON.stringify(files));
        }
      } else {
        fail("buildIndex output", out);
      }

      if (authJson) {
        const auth = JSON.parse(authJson) as string[];
        if (auth.includes("loginUser") && auth.includes("SessionStore") && auth.includes("checkPassword")) {
          ok("symbol extractor found loginUser / SessionStore / checkPassword in auth.ts");
        } else {
          fail("auth.ts symbols", JSON.stringify(auth));
        }
      } else {
        fail("auth syms output", out);
      }

      if (sliceJson) {
        const slice = JSON.parse(sliceJson) as { files: string[]; symbols: string[]; target_symbol: string };
        if (slice.files[0] === "auth.ts") ok("walk: auth.ts is the top result for 'user login authentication'");
        else fail("walk top file", "expected auth.ts, got " + slice.files[0]);
        if (slice.files.includes("crypto.ts")) ok("walk: crypto.ts pulled in via import edge");
        else fail("walk import edge", "crypto.ts not pulled in");
        if (slice.files.length <= 4) ok("walk: cap of max_files=4 respected");
        else fail("walk cap", "got " + slice.files.length + " files, expected ≤ 4");
        if (slice.target_symbol && slice.target_symbol.startsWith("auth.ts:")) {
          ok("walk: target_symbol points at the top auth.ts symbol");
        } else {
          fail("walk target_symbol", String(slice.target_symbol));
        }
      } else {
        fail("walk output", out);
      }

      if (cogJson) {
        const cog = JSON.parse(cogJson) as { files: string[]; symbols: string[]; target_symbol: string };
        if (cog.files.includes("auth.ts")) {
          ok("cognition.semantic_slice uses memory.getIndex() and returns auth.ts");
        } else {
          fail("cognition slice", JSON.stringify(cog));
        }
      } else {
        fail("cognition slice output", out);
      }

      if (det === "true") ok("retriever determinism: two walks return identical slices");
      else fail("retriever determinism", "two walks differ");

      if (emptyJson) {
        const empty = JSON.parse(emptyJson) as { files: string[]; symbols: number };
        // Even an unrelated keyword set returns an empty seed → no files
        // (we don't fall back to "any file"; that's correct behaviour).
        if (empty.files.length === 0) ok("walk: zero files when no keyword matches (no whole-repo dump)");
        else if (empty.files.length <= 4) ok("walk: bounded result even for low-relevance queries");
        else fail("empty walk", "got " + empty.files.length + " files");
      } else {
        fail("empty output", out);
      }

      if (handleJson) {
        const h = JSON.parse(handleJson) as { files: string[]; symbols: number };
        if (h.files.includes("auth.ts")) ok("getIndex() singleton: walk('login') returns auth.ts");
        else fail("singleton walk", JSON.stringify(h));
      } else {
        fail("handle output", out);
      }
    } catch (e) {
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
      fail("memory runtime", String(err.stdout || "") + " | " + String(err.stderr || ""));
    }
  }
}

// Cleanup.
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 4 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) process.exit(1);
