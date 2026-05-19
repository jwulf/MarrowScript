/**
 * MarrowScript LLM-Driven Reflection — tool implementations (Phase 20 v2)
 *
 * The closed list of tools the inference loop exposes to the model. Every
 * tool is a deterministic file-system read or AST query against the project
 * root passed in at construction time. The model can read code; it cannot
 * write, execute, or reach the network. Bounded by Phase 15's tool-call
 * budget at the call-site loop.
 *
 * Why a closed list:
 *   - The model can't invent a tool. Tool names are checked against the
 *     registry; unknown calls return an error tool-result the model has to
 *     handle on its next turn.
 *   - Every invocation has typed args validated by JSON schema.
 *   - Every read goes through `safeJoin` so the model can't escape the
 *     project root via path traversal.
 */

import * as fs from "fs";
import * as path from "path";
import type { LLMChatToolSpec, ToolFn, ToolRegistry } from "./types";

// ─── Path safety ────────────────────────────────────────────────────────────

/**
 * Resolve a relative path against the project root, then check the result
 * stays inside the root. Returns null if the path escapes (`..`) or is
 * absolute. The model gets a controlled error rather than a thrown exception.
 */
export function safeJoin(root: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0) return null;
  if (path.isAbsolute(rel)) return null;
  const resolved = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

// ─── list_directory ─────────────────────────────────────────────────────────

const listDirectorySpec: LLMChatToolSpec = {
  name: "list_directory",
  description: "List immediate contents of a directory inside the project root. Returns names + types (file | dir).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path from project root (e.g. \"src\" or \"src/auth\"). Use \".\" for the root." },
    },
    required: ["path"],
  },
};

function makeListDirectory(root: string): ToolFn {
  return async (args) => {
    const rel = String(args.path ?? ".");
    const full = rel === "." ? path.resolve(root) : safeJoin(root, rel);
    if (!full) return { error: `path is outside project root: ${rel}` };
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return { error: `not a directory: ${rel}` };
    const entries = fs.readdirSync(full, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist" && e.name !== "build")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
    return { path: rel, entries };
  };
}

// ─── read_file ──────────────────────────────────────────────────────────────

const readFileSpec: LLMChatToolSpec = {
  name: "read_file",
  description: "Read a TypeScript or JavaScript source file. Returns up to 4000 chars, truncated if longer.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path from project root (e.g. \"src/auth/login.ts\")." },
      start_line: { type: "integer", description: "Optional 1-based starting line. Default 1." },
      end_line: { type: "integer", description: "Optional 1-based ending line (inclusive). Default: 200 lines from start." },
    },
    required: ["path"],
  },
};

function makeReadFile(root: string): ToolFn {
  return async (args) => {
    const rel = String(args.path ?? "");
    const full = safeJoin(root, rel);
    if (!full) return { error: `path is outside project root: ${rel}` };
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { error: `not a file: ${rel}` };
    if (!/\.(ts|tsx|js|jsx)$/.test(full)) return { error: `not a JS/TS source file: ${rel}` };
    const raw = fs.readFileSync(full, "utf-8");
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, Math.floor(Number(args.start_line ?? 1)));
    const end = Math.min(lines.length, Math.floor(Number(args.end_line ?? Math.min(start + 199, lines.length))));
    const slice = lines.slice(start - 1, end).join("\n");
    // Cap raw size at 4000 chars so a single tool call can't blow the
    // model's context. The model can paginate via start_line / end_line.
    const capped = slice.length > 4000 ? slice.slice(0, 4000) + "\n[…truncated]" : slice;
    return { path: rel, start_line: start, end_line: end, total_lines: lines.length, content: capped };
  };
}

// ─── find_class ─────────────────────────────────────────────────────────────

const findClassSpec: LLMChatToolSpec = {
  name: "find_class",
  description: "Find class or interface declarations matching a name pattern. Returns file paths + line numbers.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Class or interface name. Exact match (case-sensitive)." },
    },
    required: ["name"],
  },
};

interface ClassMatch { name: string; kind: "class" | "interface"; file: string; line: number }

function makeFindClass(root: string): ToolFn {
  return async (args) => {
    const name = String(args.name ?? "");
    if (!name) return { error: "name required" };
    let ts: typeof import("typescript");
    try { ts = require("typescript") as typeof import("typescript"); }
    catch { return { error: "typescript module not installed" }; }
    const matches: ClassMatch[] = [];
    walkTsFiles(root).forEach(file => {
      const src = fs.readFileSync(file, "utf-8");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
      ts.forEachChild(sf, function visit(node: import("typescript").Node) {
        if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
          if (node.name?.text === name) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            matches.push({
              name,
              kind: ts.isClassDeclaration(node) ? "class" : "interface",
              file: path.relative(root, file).replace(/\\/g, "/"),
              line: line + 1,
            });
          }
        }
        ts.forEachChild(node, visit);
      });
    });
    return { name, matches };
  };
}

// ─── find_function ──────────────────────────────────────────────────────────

const findFunctionSpec: LLMChatToolSpec = {
  name: "find_function",
  description: "Find function or method declarations by name. Returns file paths + line numbers + signature.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Function or method name. Exact match (case-sensitive)." },
    },
    required: ["name"],
  },
};

interface FuncMatch { name: string; kind: "function" | "method"; file: string; line: number; signature: string }

function makeFindFunction(root: string): ToolFn {
  return async (args) => {
    const name = String(args.name ?? "");
    if (!name) return { error: "name required" };
    let ts: typeof import("typescript");
    try { ts = require("typescript") as typeof import("typescript"); }
    catch { return { error: "typescript module not installed" }; }
    const matches: FuncMatch[] = [];
    walkTsFiles(root).forEach(file => {
      const src = fs.readFileSync(file, "utf-8");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
      ts.forEachChild(sf, function visit(node: import("typescript").Node) {
        const fnName = (node as { name?: { text?: string } }).name?.text;
        if (fnName === name) {
          if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            // Build a one-line signature: name(params): returnType
            const params = node.parameters.map(p => p.getText(sf)).join(", ");
            const ret = node.type ? `: ${node.type.getText(sf)}` : "";
            matches.push({
              name,
              kind: ts.isFunctionDeclaration(node) ? "function" : "method",
              file: path.relative(root, file).replace(/\\/g, "/"),
              line: line + 1,
              signature: `${name}(${params})${ret}`,
            });
          }
        }
        ts.forEachChild(node, visit);
      });
    });
    return { name, matches };
  };
}

// ─── find_references ────────────────────────────────────────────────────────

const findReferencesSpec: LLMChatToolSpec = {
  name: "find_references",
  description: "Find references to a symbol via grep-style scan. Lower precision than an LSP but fast and dependency-free.",
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol to search for. Word-boundary matched." },
    },
    required: ["symbol"],
  },
};

interface RefMatch { file: string; line: number; preview: string }

function makeFindReferences(root: string): ToolFn {
  return async (args) => {
    const sym = String(args.symbol ?? "");
    if (!sym) return { error: "symbol required" };
    // Escape regex specials so the user's symbol can include dots etc.
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    const matches: RefMatch[] = [];
    walkTsFiles(root).forEach(file => {
      const src = fs.readFileSync(file, "utf-8");
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({
            file: path.relative(root, file).replace(/\\/g, "/"),
            line: i + 1,
            preview: lines[i].trim().slice(0, 200),
          });
          if (matches.length >= 50) return; // cap per tool call
        }
      }
    });
    return { symbol: sym, matches };
  };
}

// ─── shared file walker ─────────────────────────────────────────────────────

function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  function recurse(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) recurse(full);
      else if (e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full);
    }
  }
  recurse(root);
  return out;
}

// ─── Public registry constructor ────────────────────────────────────────────

/**
 * Build the closed tool registry for an inference run. Each tool closes
 * over `root` so the model can't supply its own. The registry is what the
 * call-site loop uses to dispatch tool_calls returned by the provider.
 */
export function buildToolRegistry(root: string): ToolRegistry {
  return {
    list_directory: { spec: listDirectorySpec, fn: makeListDirectory(root) },
    read_file: { spec: readFileSpec, fn: makeReadFile(root) },
    find_class: { spec: findClassSpec, fn: makeFindClass(root) },
    find_function: { spec: findFunctionSpec, fn: makeFindFunction(root) },
    find_references: { spec: findReferencesSpec, fn: makeFindReferences(root) },
  };
}

/** Convenience: list of tool specs (what the LLM sees in its `tools:` request). */
export function specsFromRegistry(registry: ToolRegistry): LLMChatToolSpec[] {
  return Object.values(registry).map(t => t.spec);
}
