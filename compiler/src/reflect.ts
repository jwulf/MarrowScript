/**
 * MarrowScript Code-Spec Sync (LLM Harness, Phase 20)
 *
 * Static-analysis foundation for `marrowc reflect <project_dir>` and
 * `marrowc diff-spec <spec.marrow> <project_dir>`. The v1 deliverable is the
 * AST-only inference path: scan TypeScript files for class/interface
 * declarations whose shape looks like an entity (id field + scalar fields)
 * and emit a stub .marrow source. The LLM-driven inference for capabilities,
 * state machines, and audit boundaries — the "deepest spec-kit idea" —
 * lands in v2 as a proper `infer_marrow_from_typescript` prompt with
 * tool-call-based code walking.
 *
 * What v1 does:
 *   - Walk a directory recursively, parse every .ts file into a TS source AST
 *   - Find every `class X` / `interface X` whose shape includes `id: string`
 *     or `id: uuid` (treats both as entity candidates)
 *   - Project each member to a MarrowScript primitive type (string, int,
 *     uint, float, bool, timestamp, uuid, json, list<T>) when possible
 *   - Emit a stub `system <Name> { entity X { owns: [...] } }` template
 *   - Diff: parse an existing .marrow + scan the same project, report which
 *     entity fields exist on one side but not the other (additions /
 *     removals / type changes)
 *
 * What v1 doesn't do:
 *   - Infer capabilities (would need LLM to read function bodies)
 *   - Infer state machines (would need LLM to read transition logic)
 *   - Infer authentication / audit boundaries
 *   - Round-trip: the inferred spec is "review before merging" — you'd hand-
 *     edit it anyway. The drift detector is the ongoing value.
 *
 * Determinism: file ordering is alphabetical, member ordering is preserved
 * from the source AST. No Date.now() / Math.random(). Two runs against the
 * same input produce bitwise-identical output.
 */

import * as fs from "fs";
import * as path from "path";
// We deliberately avoid importing the user's installed `typescript` module
// at the top level — it's a heavy dependency. Reflect lazily requires it
// when the CLI subcommand actually runs.

export interface ReflectedField {
  name: string;
  /** MarrowScript primitive type (best-effort projection). */
  type: string;
  /** True when the source declared the field as optional (`x?:`). */
  optional: boolean;
}

export interface ReflectedEntity {
  name: string;
  /** Source file the entity was inferred from. */
  source_file: string;
  fields: ReflectedField[];
}

export interface ReflectionResult {
  entities: ReflectedEntity[];
  /** Files we couldn't parse (logged but not fatal). */
  unparsed: string[];
}

/**
 * Recursively walk a directory and collect TypeScript source files. Skips
 * node_modules, dist, build, and dot-prefixed paths so we don't drown in
 * generated noise.
 */
function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  function recurse(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    // Sort entries alphabetically so output is stable.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) recurse(full);
      else if (e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  recurse(root);
  return out;
}

/**
 * Project a TypeScript type node to a MarrowScript primitive name. Returns
 * null when the projection is ambiguous (the caller skips ambiguous fields).
 *
 * The mapping prioritises explicit annotation: `id: string` → `uuid` ONLY
 * when the field name is "id" (common convention). All other strings stay
 * `string` so we don't fabricate type semantics the source didn't intend.
 */
function projectType(typeText: string, fieldName: string): string | null {
  const t = typeText.trim();
  // Strip trailing `| null` / `| undefined` to get the base type.
  const baseMatch = t.match(/^(.+?)(?:\s*\|\s*(?:null|undefined))+$/);
  const base = (baseMatch ? baseMatch[1] : t).trim();
  // Primitive projections.
  switch (base) {
    case "string": return fieldName === "id" ? "uuid" : "string";
    case "number":
      // Conservative: number → float (we can't tell int from float without
      // schema info). The user fixes it manually if they want stricter typing.
      return "float";
    case "boolean": return "bool";
    case "Date":
    case "Date | string": return "timestamp";
    case "any":
    case "unknown":
    case "Record<string, unknown>":
    case "Record<string, any>": return "json";
  }
  // Array projection: `T[]` or `Array<T>` → `list<T>`.
  const arrSuffix = base.match(/^(.+)\[\]$/);
  if (arrSuffix) {
    const inner = projectType(arrSuffix[1], "");
    return inner ? `list<${inner}>` : null;
  }
  const arrGeneric = base.match(/^Array<(.+)>$/);
  if (arrGeneric) {
    const inner = projectType(arrGeneric[1], "");
    return inner ? `list<${inner}>` : null;
  }
  // Specific nominal types we recognise.
  if (base === "Buffer" || base === "Uint8Array") return "bytes";
  // Unknown shape: skip. The user's manual review fills these in.
  return null;
}

/**
 * Scan one TypeScript source file and extract entity-shaped declarations.
 * "Entity-shaped" means: a class or interface that declares an `id` member
 * (any type — we look for the name, not the type, because a typeAlias might
 * widen it). Methods are ignored — v1 only models the data shape.
 */
function reflectOneFile(filePath: string, ts: typeof import("typescript")): ReflectedEntity[] {
  let source: string;
  try { source = fs.readFileSync(filePath, "utf-8"); }
  catch { return []; }
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const entities: ReflectedEntity[] = [];

  function visit(node: import("typescript").Node): void {
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const name = node.name?.text;
      if (!name) return;
      const fields: ReflectedField[] = [];
      let hasId = false;
      // Walk members. ts.isPropertyDeclaration covers class members;
      // ts.isPropertySignature covers interface members.
      for (const member of node.members) {
        let memberName: string | undefined;
        let typeText = "any";
        let optional = false;
        if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
          memberName = (member.name as { text?: string } & import("typescript").PropertyName).text;
          if (member.questionToken) optional = true;
          if (member.type) typeText = member.type.getText(sf);
        }
        if (!memberName) continue;
        if (memberName === "id") hasId = true;
        const projected = projectType(typeText, memberName);
        if (projected) fields.push({ name: memberName, type: projected, optional });
      }
      if (hasId) {
        // Sort fields alphabetically for stable diffs. Conscious choice:
        // declaration order varies between developers; alphabetical is
        // boring-but-stable. Users who want to preserve order can edit
        // the emitted .marrow before merging.
        fields.sort((a, b) => a.name.localeCompare(b.name));
        entities.push({
          name,
          source_file: filePath,
          fields,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return entities;
}

/**
 * Public API: walk a project root and return every entity-shaped declaration.
 * Entries are sorted alphabetically by name, then by source file for stable
 * output across runs.
 */
export function reflectProject(root: string): ReflectionResult {
  let ts: typeof import("typescript");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ts = require("typescript") as typeof import("typescript");
  } catch {
    throw new Error("`typescript` module not installed; reflect requires it");
  }
  const files = walkTsFiles(root);
  const out: ReflectionResult = { entities: [], unparsed: [] };
  for (const f of files) {
    try {
      const ents = reflectOneFile(f, ts);
      out.entities.push(...ents);
    } catch {
      out.unparsed.push(f);
    }
  }
  out.entities.sort((a, b) => a.name.localeCompare(b.name) || a.source_file.localeCompare(b.source_file));
  return out;
}

/**
 * Emit a stub .marrow source from a ReflectionResult. The output is a
 * single-system file with one entity per inferred class. v1 puts every
 * entity under one umbrella system named after the project root because
 * inferring system boundaries needs intent we can't read from the AST.
 */
export function emitMarrowStub(systemName: string, result: ReflectionResult): string {
  const lines: string[] = [];
  lines.push("// Inferred from TypeScript source by `marrowc reflect`. Review before merging.");
  lines.push("// Static analysis recovers entity shapes only — capabilities, state machines,");
  lines.push("// and audit boundaries need a human (or `marrowc reflect-llm`, future work).");
  lines.push("");
  lines.push(`system ${systemName} {`);
  if (result.entities.length === 0) {
    lines.push("  // No entity-shaped declarations found.");
  }
  for (const e of result.entities) {
    lines.push(`  // From: ${e.source_file}`);
    lines.push(`  entity ${e.name} {`);
    lines.push("    owns: [");
    for (let i = 0; i < e.fields.length; i++) {
      const f = e.fields[i];
      // Skip the `id` field — MarrowScript adds it automatically as part of
      // the entity ontology. Likewise `created_at` / `updated_at`.
      if (f.name === "id" || f.name === "created_at" || f.name === "updated_at") continue;
      const type = f.optional ? `optional<${f.type}>` : f.type;
      const trailing = i < e.fields.length - 1 ? "," : "";
      lines.push(`      ${f.name}: ${type}${trailing}`);
    }
    lines.push("    ]");
    lines.push("  }");
    lines.push("");
  }
  lines.push("}");
  return lines.join("\n");
}

// ─── Diff: spec vs reflected source ────────────────────────────────────────

export interface DiffEntry {
  entity: string;
  /** "added" (in source, not in spec) | "removed" (in spec, not in source) | "type_changed" */
  kind: "added" | "removed" | "type_changed";
  field: string;
  /** For added: the source type; for removed: the spec type; for type_changed: from→to. */
  detail: string;
}

export interface DiffResult {
  /** Entities present on both sides (compared field-by-field). */
  matched: string[];
  /** Entities only in source. */
  source_only: string[];
  /** Entities only in spec. */
  spec_only: string[];
  /** Per-field diffs across matched entities. */
  field_diffs: DiffEntry[];
}

/**
 * Compute a diff between an existing spec (ReflectedEntity[]) and the
 * source-derived ReflectedEntity[]. Both sides use the same shape so the
 * caller can pre-process either: load the spec via the existing parser +
 * lowering, then translate IRSystem entities into ReflectedEntity[] with
 * the same projection.
 */
export function diffEntities(spec: ReflectedEntity[], source: ReflectedEntity[]): DiffResult {
  const specByName = new Map(spec.map(e => [e.name, e]));
  const sourceByName = new Map(source.map(e => [e.name, e]));
  const matched: string[] = [];
  const source_only: string[] = [];
  const spec_only: string[] = [];
  const field_diffs: DiffEntry[] = [];

  // Stable order: union of keys, sorted.
  const allNames = [...new Set([...specByName.keys(), ...sourceByName.keys()])].sort();
  for (const name of allNames) {
    const inSpec = specByName.get(name);
    const inSrc = sourceByName.get(name);
    if (inSpec && inSrc) {
      matched.push(name);
      const specFields = new Map(inSpec.fields.map(f => [f.name, f]));
      const srcFields = new Map(inSrc.fields.map(f => [f.name, f]));
      const allFieldNames = [...new Set([...specFields.keys(), ...srcFields.keys()])].sort();
      for (const fn of allFieldNames) {
        const sf = specFields.get(fn);
        const cf = srcFields.get(fn);
        if (cf && !sf) field_diffs.push({ entity: name, kind: "added", field: fn, detail: cf.type });
        else if (sf && !cf) field_diffs.push({ entity: name, kind: "removed", field: fn, detail: sf.type });
        else if (sf && cf && sf.type !== cf.type) {
          field_diffs.push({ entity: name, kind: "type_changed", field: fn, detail: `${sf.type} → ${cf.type}` });
        }
      }
    } else if (inSrc) {
      source_only.push(name);
    } else if (inSpec) {
      spec_only.push(name);
    }
  }
  return { matched, source_only, spec_only, field_diffs };
}

/**
 * Render a DiffResult as a human-readable report for the CLI.
 */
export function formatDiff(diff: DiffResult): string {
  const lines: string[] = [];
  lines.push("Spec ↔ Source drift report");
  lines.push("==========================");
  lines.push("");
  if (diff.matched.length > 0) {
    lines.push(`Matched entities (${diff.matched.length}): ${diff.matched.join(", ")}`);
  }
  if (diff.source_only.length > 0) {
    lines.push("");
    lines.push("In source but not in spec:");
    for (const n of diff.source_only) lines.push(`  + entity ${n}`);
  }
  if (diff.spec_only.length > 0) {
    lines.push("");
    lines.push("In spec but not in source:");
    for (const n of diff.spec_only) lines.push(`  - entity ${n}`);
  }
  if (diff.field_diffs.length > 0) {
    lines.push("");
    lines.push("Field drift:");
    for (const d of diff.field_diffs) {
      const sym = d.kind === "added" ? "+" : d.kind === "removed" ? "-" : "~";
      lines.push(`  ${sym} ${d.entity}.${d.field}: ${d.detail}`);
    }
  }
  if (diff.source_only.length === 0 && diff.spec_only.length === 0 && diff.field_diffs.length === 0) {
    lines.push("");
    lines.push("v Spec and source are in sync.");
  }
  return lines.join("\n");
}
