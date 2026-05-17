/**
 * MarrowScript Cognition Phase 20 Tests — code-spec sync (v1)
 *
 * v1 deliverable: AST-only static analysis. The LLM-driven inference path
 * (capabilities, state machines, audit boundaries) lands in v2.
 *
 * Verifies:
 *   1. reflectProject walks a project directory, finds entity-shaped
 *      classes/interfaces, and projects member types to MarrowScript primitives.
 *   2. emitMarrowStub produces a valid .marrow source that the existing
 *      parser + type checker can load. Round-trip stability matters: the
 *      emitted spec parses cleanly and ontology fields (id/created_at/
 *      updated_at) are NOT re-declared.
 *   3. diffEntities reports added/removed/type_changed correctly across
 *      a synthetic spec ↔ source pair.
 *   4. formatDiff produces the documented human-readable shape.
 *   5. Determinism: two runs against the same project produce identical
 *      results (file ordering alphabetical, field ordering alphabetical).
 *   6. Type projection rules:
 *      - string → string (uuid only when the field is named `id`)
 *      - number → float (conservative — no int/float guessing)
 *      - boolean → bool
 *      - Date → timestamp
 *      - any/unknown → json
 *      - T[] / Array<T> → list<T>
 *      - Buffer / Uint8Array → bytes
 *      - optional fields (`x?:`) → optional<T> in the emitted stub
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  reflectProject,
  emitMarrowStub,
  diffEntities,
  formatDiff,
  type ReflectedEntity,
} from "../reflect";
import { Lexer } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";

let passed = 0;
let failed = 0;

function ok(name: string): void { console.log(`  v ${name}`); passed++; }
function fail(name: string, msg: string): void { console.log(`  x ${name}: ${msg}`); failed++; }

console.log("MarrowScript Cognition Phase 20 Tests — code-spec sync (v1)\n");

// ─── Set up a temp project on disk ─────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marrow-phase20-"));
const srcDir = path.join(tmpRoot, "src");
fs.mkdirSync(srcDir, { recursive: true });

fs.writeFileSync(path.join(srcDir, "user.ts"), `
// Sample entity-shaped class.
export class User {
  id: string;
  email: string;
  age: number;
  is_admin: boolean;
  created_at: Date;
  tags: string[];
  metadata: Record<string, unknown>;
  bio?: string;
}
`);
fs.writeFileSync(path.join(srcDir, "post.ts"), `
// Interface form.
export interface Post {
  id: string;
  title: string;
  body: string;
  author_id: string;
  published: boolean;
  word_count: number;
}
`);
fs.writeFileSync(path.join(srcDir, "no_id.ts"), `
// No id member — should NOT be picked up.
export class Helper {
  name: string;
  fn: () => void;
}
`);
// Skipped dirs.
fs.mkdirSync(path.join(tmpRoot, "node_modules", "x"), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, "node_modules", "x", "ignored.ts"), `
export class Ghost { id: string; }
`);

// ─── Section 1: reflectProject ─────────────────────────────────────────────

console.log("Section 1: reflectProject discovers entity-shaped declarations");

{
  const result = reflectProject(tmpRoot);
  if (result.entities.length === 2) ok("entities: 2 found (User + Post; Helper + Ghost skipped)");
  else fail("entity count", String(result.entities.length));

  const names = result.entities.map(e => e.name).sort();
  if (JSON.stringify(names) === JSON.stringify(["Post", "User"])) ok("entities: User + Post");
  else fail("entity names", JSON.stringify(names));

  // No node_modules / build / dot dirs.
  if (!result.entities.some(e => e.name === "Ghost")) ok("walk: skips node_modules");
  else fail("walk", "leaked node_modules");

  if (!result.entities.some(e => e.name === "Helper")) ok("scan: skips classes without id");
  else fail("no-id skip", "Helper got included");
}

// ─── Section 2: type projection ────────────────────────────────────────────

console.log("\nSection 2: TypeScript → MarrowScript type projection");

{
  const result = reflectProject(tmpRoot);
  const user = result.entities.find(e => e.name === "User")!;
  const findF = (n: string) => user.fields.find(f => f.name === n);

  const id = findF("id");
  if (id && id.type === "uuid") ok("id: string → uuid (when field named 'id')");
  else fail("id projection", JSON.stringify(id));

  const email = findF("email");
  if (email && email.type === "string") ok("email: string → string");
  else fail("email", JSON.stringify(email));

  const age = findF("age");
  if (age && age.type === "float") ok("age: number → float (conservative)");
  else fail("age", JSON.stringify(age));

  const isAdmin = findF("is_admin");
  if (isAdmin && isAdmin.type === "bool") ok("is_admin: boolean → bool");
  else fail("is_admin", JSON.stringify(isAdmin));

  const created = findF("created_at");
  if (created && created.type === "timestamp") ok("created_at: Date → timestamp");
  else fail("created_at", JSON.stringify(created));

  const tags = findF("tags");
  if (tags && tags.type === "list<string>") ok("tags: string[] → list<string>");
  else fail("tags", JSON.stringify(tags));

  const metadata = findF("metadata");
  if (metadata && metadata.type === "json") ok("metadata: Record<string, unknown> → json");
  else fail("metadata", JSON.stringify(metadata));

  const bio = findF("bio");
  if (bio && bio.type === "string" && bio.optional) ok("bio?: → string + optional flag");
  else fail("bio", JSON.stringify(bio));
}

// ─── Section 3: emitMarrowStub round-trips through the parser ─────────────

console.log("\nSection 3: emitMarrowStub round-trip");

{
  const result = reflectProject(tmpRoot);
  const stub = emitMarrowStub("MyApp", result);

  // Stub should not declare ontology fields (id/created_at/updated_at).
  if (!stub.match(/owns:\s*\[[^\]]*\bid:\s*uuid/m)) ok("stub: omits ontology id field");
  else fail("ontology id", "stub re-declared id");
  if (!stub.includes("created_at:")) ok("stub: omits created_at");
  else fail("ontology created_at", "stub re-declared created_at");

  // Should include the user-defined fields.
  if (stub.includes("email: string")) ok("stub: emits email");
  else fail("email", "missing");
  if (stub.includes("tags: list<string>")) ok("stub: emits tags as list<string>");
  else fail("tags", "missing");
  if (stub.includes("bio: optional<string>")) ok("stub: emits optional bio");
  else fail("optional", "missing");

  // Round-trip: the stub must parse + type-check cleanly.
  // Ontology id is auto-added by the type checker so we don't need to declare it.
  const tokens = new Lexer(stub).tokenize();
  let ast;
  try { ast = new Parser(tokens).parse(); ok("stub: parses cleanly"); }
  catch (e) { fail("parse", (e as Error).message); ast = null; }
  if (ast) {
    const errs = new TypeChecker().check(ast);
    if (errs.length === 0) ok("stub: type-checks cleanly");
    else fail("type check", errs.map(e => e.code + ":" + e.message).join("; "));
  }
}

// ─── Section 4: diffEntities ───────────────────────────────────────────────

console.log("\nSection 4: diffEntities reports drift correctly");

{
  const spec: ReflectedEntity[] = [
    {
      name: "User",
      source_file: "spec.marrow",
      fields: [
        { name: "email", type: "string", optional: false },
        { name: "age", type: "int", optional: false }, // type drift: spec says int, source says float
        { name: "old_field", type: "string", optional: false }, // removed in source
      ],
    },
    {
      name: "Removed",
      source_file: "spec.marrow",
      fields: [{ name: "x", type: "string", optional: false }],
    },
  ];
  const source: ReflectedEntity[] = [
    {
      name: "User",
      source_file: "src/user.ts",
      fields: [
        { name: "email", type: "string", optional: false },
        { name: "age", type: "float", optional: false },
        { name: "new_field", type: "bool", optional: false }, // added in source
      ],
    },
    {
      name: "Added",
      source_file: "src/added.ts",
      fields: [{ name: "y", type: "string", optional: false }],
    },
  ];
  const diff = diffEntities(spec, source);

  if (diff.matched.length === 1 && diff.matched[0] === "User") ok("matched: User on both sides");
  else fail("matched", JSON.stringify(diff.matched));

  if (diff.spec_only.length === 1 && diff.spec_only[0] === "Removed") ok("spec_only: Removed");
  else fail("spec_only", JSON.stringify(diff.spec_only));

  if (diff.source_only.length === 1 && diff.source_only[0] === "Added") ok("source_only: Added");
  else fail("source_only", JSON.stringify(diff.source_only));

  // Field diffs on User: age type changed, new_field added, old_field removed.
  const ageDiff = diff.field_diffs.find(d => d.field === "age");
  if (ageDiff && ageDiff.kind === "type_changed" && ageDiff.detail === "int → float") {
    ok("field diff: User.age type_changed (int → float)");
  } else {
    fail("age diff", JSON.stringify(ageDiff));
  }

  const addedDiff = diff.field_diffs.find(d => d.field === "new_field");
  if (addedDiff && addedDiff.kind === "added") ok("field diff: User.new_field added");
  else fail("new_field diff", JSON.stringify(addedDiff));

  const removedDiff = diff.field_diffs.find(d => d.field === "old_field");
  if (removedDiff && removedDiff.kind === "removed") ok("field diff: User.old_field removed");
  else fail("old_field diff", JSON.stringify(removedDiff));
}

// ─── Section 5: formatDiff renders the report ─────────────────────────────

console.log("\nSection 5: formatDiff");

{
  const empty = diffEntities([], []);
  const out = formatDiff(empty);
  if (out.includes("Spec ↔ Source drift report") && out.includes("v Spec and source are in sync")) {
    ok("formatDiff: clean state shows in-sync");
  } else {
    fail("clean", out.slice(0, 200));
  }

  const drift = diffEntities(
    [{ name: "X", source_file: "s.marrow", fields: [{ name: "a", type: "int", optional: false }] }],
    [{ name: "Y", source_file: "src/y.ts", fields: [{ name: "b", type: "string", optional: false }] }],
  );
  const out2 = formatDiff(drift);
  if (out2.includes("+ entity Y") && out2.includes("- entity X")) ok("formatDiff: shows added + removed entities");
  else fail("drift report", out2);
}

// ─── Section 6: determinism ────────────────────────────────────────────────

console.log("\nSection 6: determinism");

{
  const a = reflectProject(tmpRoot);
  const b = reflectProject(tmpRoot);
  if (JSON.stringify(a.entities) === JSON.stringify(b.entities)) ok("reflectProject: deterministic across two runs");
  else fail("reflect determinism", "differ");

  const stub1 = emitMarrowStub("X", a);
  const stub2 = emitMarrowStub("X", b);
  if (stub1 === stub2) ok("emitMarrowStub: deterministic across two runs");
  else fail("stub determinism", "differ");
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 20 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
