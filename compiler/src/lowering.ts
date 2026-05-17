/**
 * bone ir Lowering ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Stage 4 of the compilation pipeline.
 * Converts typed AST into the Architecture IR (spec/07_IR_SPEC.md).
 *
 * Rules:
 * - One module per semantic component
 * - All IDs are deterministic (derived from system name + component name)
 * - All ontology-entailed fields are inserted
 * - Effects are serialized in declaration order
 */

import { createHash } from "crypto";
import * as AST from "./ast";
import * as IR from "./ir";
import { lookupPromptbookEntry, renderPromptbookTemplate } from "./promptbook";
import { toSnakeCase } from "./utils";

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Deterministic ID Generation ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

function makeId(systemName: string, kind: string, name: string): string {
  const input = `${systemName}.${kind}.${name}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Duration Parsing ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

function parseDurationMs(dur: string | null): number | null {
  if (!dur) return null;
  const match = dur.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return null;
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Type Expression Serialization ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

function serializeType(t: AST.TypeExprNode): string {
  switch (t.kind) {
    case "PrimitiveType": return t.name;
    case "GenericType": return `${t.name}<${t.typeArgs.map(serializeType).join(", ")}>`;
    case "EntityRefType": return t.name;
    case "TupleType": return `(${t.elements.map(serializeType).join(", ")})`;
    case "UnionType": return t.members.map(serializeType).join(" | ");
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Expression Serialization ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

function serializeExpr(e: AST.ExprNode): string {
  switch (e.kind) {
    case "Literal":
      if (e.type === "string") return `"${e.value}"`;
      if (e.type === "list") return `[${(e.value as AST.ExprNode[]).map(serializeExpr).join(", ")}]`;
      return String(e.value);
    case "FieldRef":
      return e.path.join(".");
    case "BinaryExpr":
      return `(${serializeExpr(e.left)} ${e.op} ${serializeExpr(e.right)})`;
    case "UnaryExpr":
      return `(${e.op} ${serializeExpr(e.operand)})`;
    case "CallExpr":
      return `${e.name}(${e.args.map(serializeExpr).join(", ")})`;
    case "TernaryExpr":
      return `(${serializeExpr(e.condition)} ? ${serializeExpr(e.consequent)} : ${serializeExpr(e.alternate)})`;
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Lowering Engine ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

export class Lowering {
  private systemName: string = "";

  lower(program: AST.ProgramNode, sourceHash: string): IR.IRSystem[] {
    const systems: IR.IRSystem[] = [];

    for (const sys of program.systems) {
      systems.push(this.lowerSystem(sys, sourceHash));
    }

    return systems;
  }

  private lowerSystem(sys: AST.SystemDeclNode, sourceHash: string): IR.IRSystem {
    this.systemName = sys.name;

    const modules: IR.IRModule[] = [];
    const events: IR.IREvent[] = [];
    const flows: IR.IRFlow[] = [];
    const invariants: IR.IRInvariant[] = [];

    // Collect declarations by type
    const entities = sys.declarations.filter((d): d is AST.EntityDeclNode => d.kind === "EntityDecl");
    const capabilities = sys.declarations.filter((d): d is AST.CapabilityDeclNode => d.kind === "CapabilityDecl");
    const channels = sys.declarations.filter((d): d is AST.ChannelDeclNode => d.kind === "ChannelDecl");
    const stores = sys.declarations.filter((d): d is AST.StoreDeclNode => d.kind === "StoreDecl");
    const eventDecls = sys.declarations.filter((d): d is AST.EventDeclNode => d.kind === "EventDecl");
    const constraints = sys.declarations.filter((d): d is AST.ConstraintDeclNode => d.kind === "ConstraintDecl");
    const policies = sys.declarations.filter((d): d is AST.PolicyDeclNode => d.kind === "PolicyDecl");
    const flowDecls = sys.declarations.filter((d): d is AST.FlowDeclNode => d.kind === "FlowDecl");
    const extensionPoints = sys.declarations.filter((d): d is AST.ExtensionPointDeclNode => d.kind === "ExtensionPointDecl");
    // Cognition Layer (LLM Harness, Phase 1): collect new top-level decls.
    const modelDecls = sys.declarations.filter((d): d is AST.ModelDeclNode => d.kind === "ModelDecl");
    const promptDecls = sys.declarations.filter((d): d is AST.PromptDeclNode => d.kind === "PromptDecl");
    const routerDecls = sys.declarations.filter((d): d is AST.RouterDeclNode => d.kind === "RouterDecl");
    // Phase 16: evaluation decls — typed regression tests for prompts.
    const evaluationDecls = sys.declarations.filter((d): d is AST.EvaluationDeclNode => d.kind === "EvaluationDecl");

    // Lower stores ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ data_store modules
    for (const store of stores) {
      modules.push(this.lowerStore(store));
    }

    // Lower entities ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ api_service modules (with CRUD + capabilities)
    for (const entity of entities) {
      const relatedCaps = capabilities.filter(c =>
        c.params.some(p => p.type.kind === "EntityRefType" && p.type.name === entity.name)
      );
      modules.push(this.lowerEntity(entity, relatedCaps, stores, policies));
    }

    // Lower channels ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ realtime_service modules
    for (const channel of channels) {
      modules.push(this.lowerChannel(channel));
    }

    // Lower events
    for (const ev of eventDecls) {
      events.push(this.lowerEvent(ev));
    }

    // Lower flows
    for (const flow of flowDecls) {
      flows.push(this.lowerFlow(flow));
    }

    // Lower constraints ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ invariants
    for (const c of constraints) {
      invariants.push({
        id: makeId(this.systemName, "invariant", c.name),
        expression: serializeExpr(c.expr),
        scope: "global",
      });
    }

    // Add gateway module (ontology: always present)
    const gatewayConfig: Record<string, string | number | boolean> = {
      rate_limit: 1000,
      cors: true,
      tls: true,
    };
    if (policies.length > 0) {
      const mainPolicy = policies[0];
      if (mainPolicy.rateLimit) {
        gatewayConfig["rate_limit"] = mainPolicy.rateLimit.count;
      }
      if (mainPolicy.encryption) {
        gatewayConfig["encryption"] = mainPolicy.encryption;
      }
    }
    modules.push({
      id: makeId(this.systemName, "gateway", "APIGateway"),
      kind: "gateway",
      name: "APIGateway",
      interfaces: [],
      models: [],
      events: [],
      state_machines: [],
      relations: [],
      dependencies: modules.filter(m => m.kind === "api_service" || m.kind === "realtime_service").map(m => m.id),
      config: gatewayConfig,
    });

    return {
      name: sys.name,
      version: "1.0.0",
      source_hash: sourceHash,
      domain: sys.domain,
      modules,
      events,
      flows,
      invariants,
      resolution: {},
      extension_points: extensionPoints.map(ep => ({
        name: ep.name,
        params: ep.params.map(p => ({ name: p.name, type: serializeType(p.type) })),
        returns: ep.returns ? serializeType(ep.returns) : null,
        stable: ep.stable,
      })),
      models: modelDecls.map(m => this.lowerModel(m)),
      prompts: promptDecls.map(p => this.lowerPrompt(p)),
      routers: routerDecls.map(r => this.lowerRouter(r)),
      // Phase 15: collect cognition-bearing capabilities referenced from
      // any prompt's allowed_tools. Cognition-only capabilities (no
      // entity-typed param) wouldn't otherwise show up in modules at all.
      tool_capabilities: this.collectToolCapabilities(promptDecls, capabilities),
      // Phase 16: typed regression tests for prompts. Lowered straight from
      // AST since they have no runtime presence — they're consumed by
      // emit_evaluation.ts and the marrowc evaluate CLI.
      evaluations: evaluationDecls.map(e => this.lowerEvaluation(e)),
      // Phase 21: collect cost budgets across all policies. Each policy may
      // declare any number of budgets; the runtime emitter walks the merged
      // list once.
      cost_budgets: this.collectCostBudgets(policies),
    };
  }

  /**
   * Phase 15: build the IR-level descriptor for every cognition-bearing
   * capability listed in some prompt's allowed_tools. The type checker (T029)
   * already enforces that each tool capability has cognition: <primitive>;
   * here we just translate that AST shape into IR for the cognition emitter.
   */
  private collectToolCapabilities(
    prompts: AST.PromptDeclNode[],
    capabilities: AST.CapabilityDeclNode[],
  ): IR.IRToolCapability[] {
    const referenced = new Set<string>();
    for (const p of prompts) {
      for (const t of p.allowedTools) referenced.add(t);
    }
    const byName = new Map<string, AST.CapabilityDeclNode>();
    for (const c of capabilities) byName.set(c.name, c);
    const out: IR.IRToolCapability[] = [];
    // Iterate the referenced set in alphabetical order so the IR is stable
    // regardless of source-order — the dispatch table emitter relies on this
    // for bitwise-identical re-runs.
    const names = [...referenced].sort();
    for (const name of names) {
      const cap = byName.get(name);
      if (!cap || !cap.cognition) continue; // T029 already errored
      out.push({
        name: cap.name,
        params: cap.params.map(p => ({
          name: p.name,
          type: serializeType(p.type),
          nullable: false,
          unique: false,
          indexed: false,
          default_value: null,
        })),
        cognition_primitive: cap.cognition.name,
        bindings: cap.cognition.using.map(b => ({
          param: b.param,
          value: serializeExpr(b.value),
        })),
        return_type: cap.returns ? serializeType(cap.returns) : "string",
      });
    }
    return out;
  }

  /**
   * Phase 21: collect every cost-budget across all policies. Each budget gets
   * a stable id derived from its identity (policy/scope/feature/window/cap).
   * The runtime emitter walks this list once to generate counter tables and
   * the assertWithinBudget helper.
   */
  private collectCostBudgets(policies: AST.PolicyDeclNode[]): IR.IRCostBudget[] {
    const out: IR.IRCostBudget[] = [];
    for (const policy of policies) {
      for (let i = 0; i < policy.costBudgets.length; i++) {
        const b = policy.costBudgets[i];
        // Stable id: policy + scope + feature + window. Index suffix
        // disambiguates two budgets on the same scope+window with different caps.
        const idParts = [policy.name, b.scope, b.feature ?? "", b.window, String(i)];
        const id = idParts.join(":");
        out.push({
          id,
          policy: policy.name,
          scope: b.scope,
          feature: b.feature,
          window_ms: parseDurationMs(b.window) || 60_000,
          cap_usd: b.capUsd,
          cap_tokens: b.capTokens,
          cap_calls: b.capCalls,
          action: b.action,
          retry_after_ms: b.retryAfter ? parseDurationMs(b.retryAfter) : null,
          error_code: b.errorCode,
        });
      }
    }
    return out;
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Store Lowering ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  private lowerStore(store: AST.StoreDeclNode): IR.IRModule {
    // Strip "Store" suffix from model name so SellerStore → Seller → table "sellers"
    const entityName = store.name.replace(/Store$/, "") || store.name;
    const model: IR.IRModel = {
      name: entityName,
      fields: store.schema.map(f => this.lowerField(f)),
      primary_key: "id",
      indexes: [],
      constraints: [],
    };

    // Add id field if not present
    if (!model.fields.find(f => f.name === "id")) {
      model.fields.unshift({
        name: "id", type: "uuid", nullable: false, unique: true, indexed: true, default_value: "gen_random_uuid()",
      });
    }

    return {
      id: makeId(this.systemName, "data_store", store.name),
      kind: "data_store",
      name: store.name,
      interfaces: [],
      models: [model],
      events: [],
      state_machines: [],
      relations: [],
      dependencies: [],
      config: {
        engine: store.engine || "postgresql",
        replicas: store.replicas || 1,
        ...(store.retention ? { retention_ms: parseDurationMs(store.retention) || 0 } : {}),
        ...(store.partition ? { partition_key: store.partition } : {}),
      },
    };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Entity Lowering ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  private lowerEntity(entity: AST.EntityDeclNode, capabilities: AST.CapabilityDeclNode[], stores: AST.StoreDeclNode[], policies: AST.PolicyDeclNode[] = []): IR.IRModule {
    const moduleId = makeId(this.systemName, "api_service", `${entity.name}Service`);

    // Build model from entity fields + ontology entailments
    const fields: IR.IRField[] = [
      { name: "id", type: "uuid", nullable: false, unique: true, indexed: true, default_value: "gen_random_uuid()" },
      { name: "created_at", type: "timestamp", nullable: false, unique: false, indexed: true, default_value: "now()" },
      { name: "updated_at", type: "timestamp", nullable: false, unique: false, indexed: false, default_value: "now()" },
    ];
    for (const f of entity.owns) {
      fields.push(this.lowerField(f));
    }

    // Auto-add foreign key columns for `belongs_to` relations.
    //
    // Without this, generated migrations reference a column that doesn't exist
    // (e.g. `FOREIGN KEY (seller_id) REFERENCES sellers(id)` when no seller_id
    // is declared in `owns:`). Users were having to duplicate the FK in
    // `owns:` to make it work; we now synthesize it.
    //
    // If the user already declared a column with the same name (the legacy
    // pattern), we don't add a duplicate — their declaration wins so they
    // can override nullability or add @sensitive.
    const existingFieldNames = new Set(fields.map(f => f.name));
    for (const rel of entity.relations) {
      if (rel.relationType !== "belongs_to") continue;
      const fkName = toSnakeCase(rel.target) + "_id";
      if (existingFieldNames.has(fkName)) continue;
      fields.push({
        name: fkName,
        type: "uuid",
        nullable: false,
        unique: false,
        indexed: true,
        default_value: null,
      });
      existingFieldNames.add(fkName);
    }

    // Add derived fields as generated columns (stored: false = virtual)
    const derivedFields: IR.IRField[] = entity.derived.map(d => ({
      name: d.name,
      type: "json", // type inferred at runtime
      nullable: true,
      unique: false,
      indexed: false,
      default_value: `GENERATED ALWAYS AS (${serializeExpr(d.expr)}) STORED`,
    }));

    // Build indexes from entity index declarations
    const indexes: IR.IRIndex[] = [];
    for (const idx of entity.indexes) {
      indexes.push({ fields: idx, unique: false });
    }

    // Build constraints from entity constraints
    const modelConstraints: IR.IRModelConstraint[] = [];
    for (const c of entity.constraints) {
      const serialized = serializeExpr(c);
      // Detect unique constraints
      if (c.kind === "FieldRef" && c.path[c.path.length - 1] === "unique") {
        const field = c.path.slice(0, -1).join(".");
        modelConstraints.push({ kind: "unique", target: field, params: {} });
        indexes.push({ fields: [field], unique: true });
      } else {
        modelConstraints.push({ kind: "check", target: entity.name, params: { expression: serialized } });
      }
    }

    const model: IR.IRModel = {
      name: entity.name,
      fields: [...fields, ...derivedFields],
      primary_key: "id",
      indexes,
      constraints: modelConstraints,
    };

    // Build state machine if entity has states
    const stateMachines: IR.IRStateMachine[] = [];
    if (entity.states) {
      const states = entity.states.nodes.map(n => n.name);
      const transitions: IR.IRTransition[] = [];
      for (const node of entity.states.nodes) {
        for (const target of node.transitions) {
          transitions.push({ from: node.name, to: target, trigger: `${node.name}_to_${target}`, guard: null });
        }
        for (const target of node.branches) {
          transitions.push({ from: node.name, to: target, trigger: `${node.name}_to_${target}`, guard: null });
        }
      }
      stateMachines.push({
        entity: entity.name,
        states,
        initial: states[0],
        transitions,
      });
    }

    // Build interface from capabilities
    const methods: IR.IRMethod[] = [];

    // CRUD methods (always generated for entities)
    methods.push(this.makeCrudMethod("create", entity.name, fields));
    methods.push(this.makeCrudMethod("read", entity.name, fields));
    methods.push(this.makeCrudMethod("update", entity.name, fields));
    methods.push(this.makeCrudMethod("delete", entity.name, fields));
    methods.push(this.makeCrudMethod("list", entity.name, fields));

    // Capability-derived methods
    for (const cap of capabilities) {
      methods.push(this.lowerCapability(cap));
    }

    const iface: IR.IRInterface = {
      name: `I${entity.name}Service`,
      methods,
    };

    // Find related store
    const relatedStore = stores.find(s => s.name.toLowerCase().includes(entity.name.toLowerCase()));
    const deps: string[] = [];
    if (relatedStore) {
      deps.push(makeId(this.systemName, "data_store", relatedStore.name));
    }

    // Lower relations
    const relations: IR.IRRelation[] = entity.relations.map(rel => {
      const fromTable = toSnakeCase(entity.name) + "s";
      const toTable = toSnakeCase(rel.target) + "s";
      let foreignKey: string;
      let junctionTable: string | undefined;

      switch (rel.relationType) {
        case "belongs_to":
          foreignKey = toSnakeCase(rel.target) + "_id";
          break;
        case "has_one":
        case "has_many":
          foreignKey = toSnakeCase(entity.name) + "_id";
          break;
        case "many_to_many":
          foreignKey = toSnakeCase(entity.name) + "_id";
          junctionTable = [fromTable, toTable].sort().join("_");
          break;
        default:
          foreignKey = toSnakeCase(rel.target) + "_id";
      }

      return {
        name: rel.name,
        kind: rel.relationType,
        from_entity: entity.name,
        to_entity: rel.target,
        from_table: fromTable,
        to_table: toTable,
        foreign_key: foreignKey,
        junction_table: junctionTable,
      };
    });

    return {
      id: moduleId,
      kind: "api_service",
      name: `${entity.name}Service`,
      interfaces: [iface],
      models: [model],
      events: [],
      state_machines: stateMachines,
      relations,
      dependencies: deps,
      config: {
        authenticated: entity.auth !== null && entity.auth !== "none",
        auth_method: entity.auth || "none",
        audit: policies.some(p => p.audit === true),
        rate_limit: policies.length > 0 && policies[0].rateLimit ? policies[0].rateLimit.count : 0,
        rate_limit_window_ms: policies.length > 0 && policies[0].rateLimit ? (parseDurationMs(String(policies[0].rateLimit.per)) || 60000) : 60000,
      },
    };
  }

  private makeCrudMethod(op: string, entityName: string, fields: IR.IRField[]): IR.IRMethod {
    const input: IR.IRField[] = op === "create" || op === "update"
      ? fields.filter(f => f.name !== "id" && f.name !== "created_at" && f.name !== "updated_at")
      : op === "list"
        ? [
            { name: "page", type: "uint", nullable: true, unique: false, indexed: false, default_value: "1" },
            { name: "page_size", type: "uint", nullable: true, unique: false, indexed: false, default_value: "50" },
          ]
        : [{ name: "id", type: "uuid", nullable: false, unique: true, indexed: true, default_value: null }];

    return {
      name: op,
      input,
      output: op === "list" ? `list<${entityName}>` : op === "delete" ? "bool" : entityName,
      preconditions: [],
      effects: [],
      emissions: [],
      idempotent: op === "read" || op === "list",
      authenticated: true,
      timeout_ms: 30000,
      retry: null,
      pipeline: null,
      algorithm: null,
      cognition: null,
      sync: null,
    };
  }

  private lowerCapability(cap: AST.CapabilityDeclNode): IR.IRMethod {
    const input: IR.IRField[] = cap.params.map(p => ({
      name: p.name,
      type: serializeType(p.type),
      nullable: false,
      unique: false,
      indexed: false,
      default_value: null,
    }));

    const preconditions: IR.IRPrecondition[] = cap.requires.map(r => ({
      expression: serializeExpr(r),
      description: serializeExpr(r),
    }));

    const effects: IR.IREffect[] = cap.effects.map(e => ({
      target: e.target.path.join("."),
      op: e.op === "=" ? "assign" as const : e.op === "+=" ? "add" as const : "remove" as const,
      value: serializeExpr(e.value),
    }));

    const emissions = cap.emits.map(e => e.eventName);

    // Lower pipeline if present
    let pipeline: IR.IRPipeline | null = null;
    if (cap.pipeline) {
      pipeline = {
        parallel: cap.pipeline.parallel,
        steps: cap.pipeline.steps.map(step => {
          if (step.kind === "PipelineMatch") {
            // Phase 11: lower a runtime match dispatch.
            const m: IR.IRPipelineMatch = {
              kind: "match",
              key_expr: serializeExpr(step.key),
              cases: step.cases.map(c => ({
                literal: c.literal,
                literal_kind: c.literalKind,
                arm: {
                  kind: "step",
                  call_name: c.arm.call.name,
                  call_args: c.arm.call.args.map(a => serializeExpr(a)),
                  bind_as: c.arm.bindAs,
                },
              })),
              default_arm: step.defaultArm
                ? {
                    kind: "step",
                    call_name: step.defaultArm.call.name,
                    call_args: step.defaultArm.call.args.map(a => serializeExpr(a)),
                    bind_as: step.defaultArm.bindAs,
                  }
                : null,
            };
            return m;
          }
          // Plain step.
          const s: IR.IRPipelineStep = {
            kind: "step",
            call_name: step.call.name,
            call_args: step.call.args.map(a => serializeExpr(a)),
            bind_as: step.bindAs,
          };
          return s;
        }),
        on_error: cap.pipeline.onError ? {
          action: cap.pipeline.onError.action,
          call_name: cap.pipeline.onError.call?.name || null,
          call_args: cap.pipeline.onError.call?.args.map(a => serializeExpr(a)) || [],
        } : null,
      };
    }

    // Lower algorithm if present
    let algorithm: IR.IRAlgorithm | null = null;
    if (cap.algorithm) {
      algorithm = {
        catalog_name: cap.algorithm.name,
        bindings: cap.algorithm.using.map(b => ({
          param: b.param,
          value: serializeExpr(b.value),
        })),
      };
    }

    // Lower cognition binding if present (LLM Harness, Phase 1).
    // Mirrors algorithm lowering — the cognition catalog is closed and
    // resolved by emit_cognition.ts in Phase 2.
    let cognition: IR.IRCognitionBinding | null = null;
    if (cap.cognition) {
      cognition = {
        catalog_name: cap.cognition.name,
        bindings: cap.cognition.using.map(b => ({
          param: b.param,
          value: serializeExpr(b.value),
        })),
      };
    }

    return {
      name: cap.name,
      input,
      output: cap.returns ? serializeType(cap.returns) : "result<void, error>",
      preconditions,
      effects,
      emissions,
      idempotent: cap.idempotent || false,
      authenticated: true,
      timeout_ms: parseDurationMs(cap.timeout) || 30000,
      retry: cap.retry ? {
        max_attempts: cap.retry.maxAttempts || 3,
        backoff: (cap.retry.backoff as IR.IRRetryPolicy["backoff"]) || "exponential",
        interval_ms: parseDurationMs(cap.retry.interval) || 1000,
      } : null,
      pipeline,
      algorithm,
      cognition,
      sync: cap.sync,
    };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Channel Lowering ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  private lowerChannel(channel: AST.ChannelDeclNode): IR.IRModule {
    return {
      id: makeId(this.systemName, "realtime_service", channel.name),
      kind: "realtime_service",
      name: channel.name,
      interfaces: [{
        name: `I${channel.name}Channel`,
        methods: [
          { name: "connect", input: [], output: "connection", preconditions: [], effects: [], emissions: [], idempotent: false, authenticated: true, timeout_ms: 5000, retry: null, pipeline: null, algorithm: null, cognition: null, sync: null },
          { name: "subscribe", input: [{ name: "topic", type: "string", nullable: false, unique: false, indexed: false, default_value: null }], output: "subscription", preconditions: [], effects: [], emissions: [], idempotent: true, authenticated: true, timeout_ms: 5000, retry: null, pipeline: null, algorithm: null, cognition: null, sync: null },
          { name: "publish", input: [{ name: "message", type: "json", nullable: false, unique: false, indexed: false, default_value: null }], output: "void", preconditions: [], effects: [], emissions: [], idempotent: false, authenticated: true, timeout_ms: 5000, retry: null, pipeline: null, algorithm: null, cognition: null, sync: null },
        ],
      }],
      models: [],
      events: [],
      state_machines: [],
      relations: [],
      dependencies: [],
      config: {
        transport: channel.transport || "websocket",
        ordering: channel.ordering || "fifo",
        persistence: channel.persistence || "none",
        max_size: channel.maxSize || 10000,
      },
    };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Event Lowering ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  private lowerEvent(ev: AST.EventDeclNode): IR.IREvent {
    return {
      id: makeId(this.systemName, "event", ev.name),
      name: ev.name,
      payload: ev.payload.map(f => this.lowerField(f)),
      source: "unknown", // resolved during dependency resolution
      delivery: (ev.delivery as IR.IRDeliveryMode) || "at_least_once",
      ordering: "fifo",
      ttl_ms: parseDurationMs(ev.ttl),
    };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Flow Lowering ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  private lowerFlow(flow: AST.FlowDeclNode): IR.IRFlow {
    return {
      name: flow.name,
      steps: flow.steps.map(s => ({
        name: s.name,
        action: `${s.action.name}(${s.action.args.map(serializeExpr).join(", ")})`,
        compensation: s.compensate ? `${s.compensate.name}(${s.compensate.args.map(serializeExpr).join(", ")})` : null,
        // Phase 17: lower the optional checkpoint clause. Show-expressions
        // are serialised the same way as constraints (string-shaped) so the
        // emitter can either embed them as JSON paths or surface them via
        // ctx lookups.
        checkpoint: s.checkpoint ? {
          name: s.checkpoint.name,
          shows: s.checkpoint.shows.map(serializeExpr),
          allow: [...s.checkpoint.allow],
          timeout_ms: parseDurationMs(s.checkpoint.timeout),
          on_timeout: s.checkpoint.onTimeout,
        } : null,
      })),
    };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Field Lowering ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  private lowerField(f: AST.FieldNode): IR.IRField {
    return {
      name: f.name,
      type: serializeType(f.type),
      nullable: f.type.kind === "GenericType" && f.type.name === "optional",
      unique: false,
      indexed: false,
      default_value: f.defaultValue ? serializeExpr(f.defaultValue) : null,
      renamed_from: f.renamedFrom ?? null,
      sensitive: f.sensitive ?? false,
    };
  }

  // ─── Cognition Layer Lowering (LLM Harness, Phase 1) ───────────────────────
  // Defaults are deliberate and chosen to produce safe, low-cost behavior:
  //   - temperature defaults to 0.0 (deterministic-friendly)
  //   - validate defaults to none (Phase 2 emit_cognition.ts will use the
  //     prompt's `returns:` type to derive a Zod schema when validate=schema_only)
  //   - on_invalid defaults to fail (no silent retry loops)
  //   - cost/latency classes default to "small"/"medium" (most local models)

  private lowerModel(m: AST.ModelDeclNode): IR.IRCogModel {
    if (m.provider === null) {
      throw new Error(`Model '${m.name}' is missing required 'provider' field`);
    }
    if (m.modelName === null) {
      throw new Error(`Model '${m.name}' is missing required 'name' field (the provider-specific model identifier)`);
    }
    return {
      id: makeId(this.systemName, "model", m.name),
      name: m.name,
      provider: m.provider as IR.IRProviderKind,
      model_name: m.modelName,
      endpoint: m.endpoint,
      context_window: m.contextWindow ?? 4096,
      max_output: m.maxOutput ?? 1024,
      temperature: m.temperature ?? 0.0,
      top_p: m.topP,
      stop: m.stop ?? [],
      cost_class: (m.costClass ?? "small") as IR.IRCostClass,
      latency_class: (m.latencyClass ?? "medium") as IR.IRLatencyClass,
      vram_mb: m.vramMb,
      quant: m.quant,
    };
  }

  private lowerPrompt(p: AST.PromptDeclNode): IR.IRPrompt {
    // Phase 18: when promptbook is referenced, render the entry's baseline
    // template at compile time using the user's `with:` args. The lowered
    // shape is then identical to a plain `template:` prompt — no runtime
    // dependency on the promptbook module. The renderer leaves
    // `{{__input.<name>}}` placeholders intact so the cognition emitter
    // can substitute them with prompt-call inputs.
    let resolvedTemplate = p.template;
    if (p.promptbookRef) {
      const entry = lookupPromptbookEntry(p.promptbookRef);
      if (!entry) {
        throw new Error(`Prompt '${p.name}' references unknown promptbook entry '${p.promptbookRef}'`);
      }
      // Coerce arg values to literals. Expression values are best-effort —
      // simple literals are extracted; anything else surfaces as an error.
      const args: Record<string, string | number | string[]> = {};
      for (const a of p.promptbookArgs) {
        const v = a.value;
        if (v.kind === "Literal") {
          if (v.type === "list") {
            args[a.name] = (v.value as AST.ExprNode[]).map(item => {
              if (item.kind === "Literal" && item.type === "string") return String(item.value);
              return serializeExpr(item);
            });
          } else {
            args[a.name] = v.value as string | number;
          }
        } else {
          // Non-literal: serialise as a string so the user's intent (e.g.
          // referencing another decl) survives as a debuggable artifact.
          args[a.name] = serializeExpr(v);
        }
      }
      resolvedTemplate = renderPromptbookTemplate(entry, args);
    }
    if (resolvedTemplate === null) {
      throw new Error(`Prompt '${p.name}' is missing required 'template' or 'promptbook' field`);
    }
    if (p.modelRef === null && p.routerRef === null) {
      throw new Error(`Prompt '${p.name}' must reference either a model or a router`);
    }
    if (p.modelRef !== null && p.routerRef !== null) {
      throw new Error(`Prompt '${p.name}' cannot reference both a model and a router (choose one)`);
    }

    const validate: IR.IRValidateMode =
      p.validate.kind === "custom"
        ? { kind: "custom", extension_point: p.validate.extensionPoint }
        : { kind: p.validate.kind };

    const cache: IR.IRPromptCache | null = p.cache
      ? {
          key_expr: p.cache.keyExpr ? serializeExpr(p.cache.keyExpr) : "",
          ttl_ms: parseDurationMs(p.cache.ttl) ?? 3_600_000,
        }
      : null;

    const input: IR.IRField[] = p.params.map(param => ({
      name: param.name,
      type: serializeType(param.type),
      nullable: false,
      unique: false,
      indexed: false,
      default_value: null,
    }));

    return {
      id: makeId(this.systemName, "prompt", p.name),
      name: p.name,
      input,
      output_type: p.returns ? serializeType(p.returns) : "json",
      model_ref: p.modelRef,
      router_ref: p.routerRef,
      template: resolvedTemplate,
      validate,
      on_invalid: p.onInvalid,
      retry: p.retry
        ? {
            max_attempts: p.retry.maxAttempts ?? 3,
            backoff: (p.retry.backoff as IR.IRRetryPolicy["backoff"]) ?? "exponential",
            interval_ms: parseDurationMs(p.retry.interval) ?? 1000,
          }
        : null,
      timeout_ms: parseDurationMs(p.timeout) ?? 30_000,
      cache,
      idempotent: p.idempotent ?? false,
      constraints: p.constraints.map(c => serializeExpr(c)),
      allowed_tools: [...p.allowedTools],
    };
  }

  private lowerRouter(r: AST.RouterDeclNode): IR.IRRouter {
    if (r.byExpr === null) {
      throw new Error(`Router '${r.name}' is missing required 'by:' expression`);
    }
    return {
      id: makeId(this.systemName, "router", r.name),
      name: r.name,
      by_expr: serializeExpr(r.byExpr),
      tiers: r.tiers.map(t => ({
        name: t.name,
        max: t.max,
        model_ref: t.modelRef,
      })),
      on_low_confidence: r.onLowConfidence,
      confidence_threshold: r.confidenceThreshold ?? 0.0,
      fallback_model_ref: r.fallbackModel,
      // Phase 19: observed metrics + policy. The runtime emitter uses these
      // to wire metrics counters per call. The tuner CLI (offline / future)
      // reads recorded metrics to recompute tier thresholds.
      observe: [...r.observe],
      policy: r.policy
        ? {
            objective: r.policy.objective,
            constraints: r.policy.constraints.map(serializeExpr),
          }
        : null,
    };
  }

  /**
   * Phase 16: lower an evaluation decl. Cases preserve declaration order so
   * the runner produces deterministic per-case output. Expectations are
   * lowered to a closed IR union for simple emitter dispatch.
   */
  private lowerEvaluation(e: AST.EvaluationDeclNode): IR.IREvaluation {
    return {
      id: makeId(this.systemName, "evaluation", e.name),
      name: e.name,
      prompt_ref: e.promptRef,
      cases: e.cases.map(c => ({
        name: c.caseName,
        input: c.input.map(b => ({ param: b.param, value: serializeExpr(b.value) })),
        expectations: c.expectations.map(exp => this.lowerEvaluationExpectation(exp)),
      })),
      metric: e.metric?.metric ?? "pass_rate",
      min_pass_rate: e.baseline?.minPassRate ?? 0,
      schedule_on: e.schedule?.on ?? [],
    };
  }

  private lowerEvaluationExpectation(exp: AST.EvaluationExpectationNode): IR.IREvaluationExpectation {
    switch (exp.kind) {
      case "ExpPasses":
        return { kind: "passes", mode: exp.mode };
      case "ExpContainsClassNamed":
        return { kind: "contains_class_named", pattern: exp.pattern };
      case "ExpMustContainString":
        return { kind: "must_contain_string", values: exp.values };
      case "ExpMustNotContainString":
        return { kind: "must_not_contain_string", values: exp.values };
      case "ExpImportsOnlyFrom":
        return { kind: "imports_only_from", allowed: exp.allowed };
      case "ExpMaxLines":
        return { kind: "max_lines", value: exp.value };
      case "ExpMinLines":
        return { kind: "min_lines", value: exp.value };
      case "ExpLatencyUnderMs":
        return { kind: "latency_under_ms", value: exp.value };
    }
  }
}
