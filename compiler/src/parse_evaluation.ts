/**
 * MarrowScript Evaluation Decl Parser (LLM Harness, Phase 16)
 *
 * Parses an `evaluation` block:
 *
 *   evaluation generate_quality {
 *     prompt: generate_artifact
 *
 *     cases: [
 *       {
 *         name: "simple"
 *         input: { description: "...", complexity: 0.5 }
 *         expected: {
 *           passes: ast_compiles
 *           contains_class_named: "^[A-Z][a-zA-Z]+Adapter$"
 *           max_lines: 400
 *         }
 *       }
 *     ]
 *
 *     metric: pass_rate
 *     baseline: { min_pass_rate: 0.85 }
 *     schedule: { on: ["pre_commit", "ci_pr"] }
 *   }
 *
 * The expectation operators are a closed list — adding one means adding a
 * lexer keyword, an AST union arm, a parser case here, and a runtime emit
 * branch in emit_evaluation.ts. Type checking happens in typechecker.ts
 * (codes T030–T034).
 */

import { TokenKind } from "./lexer";
import { TokenStream } from "./parser_base";
import * as AST from "./ast";
import { parseExpr } from "./parse_expr";

function parseStringLiteral(s: TokenStream, context: string): string {
  return s.expect(TokenKind.StringLiteral, context).value;
}

function parseIntLiteral(s: TokenStream, context: string): number {
  return parseInt(s.expect(TokenKind.IntLiteral, context).value, 10);
}

function parseFloatLiteral(s: TokenStream, context: string): number {
  // Accept either a float or an int literal; the spec allows both for thresholds.
  const tok = s.peek();
  if (tok.kind === TokenKind.FloatLiteral) {
    s.advance();
    return parseFloat(tok.value);
  }
  if (tok.kind === TokenKind.IntLiteral) {
    s.advance();
    return parseInt(tok.value, 10);
  }
  throw new Error(`Expected ${context} (number) at ${tok.loc.line}:${tok.loc.column}, got ${tok.kind}`);
}

function parseStringList(s: TokenStream): string[] {
  s.expect(TokenKind.LBracket, "[");
  const items: string[] = [];
  if (!s.check(TokenKind.RBracket)) {
    do { items.push(parseStringLiteral(s, "string")); } while (s.match(TokenKind.Comma));
  }
  s.expect(TokenKind.RBracket, "]");
  return items;
}

export function parseEvaluationDecl(s: TokenStream): AST.EvaluationDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwEvaluation, "evaluation");
  const name = s.expect(TokenKind.Identifier, "evaluation name").value;
  s.expect(TokenKind.LBrace, "{");

  const node: AST.EvaluationDeclNode = {
    kind: "EvaluationDecl",
    loc,
    name,
    promptRef: "",
    cases: [],
    metric: null,
    baseline: null,
    schedule: null,
  };

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    switch (tok.kind) {
      case TokenKind.KwPrompt:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.promptRef = s.expect(TokenKind.Identifier, "prompt name").value;
        break;
      case TokenKind.KwCases:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.cases = parseCaseList(s);
        break;
      case TokenKind.KwMetric:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.metric = parseMetric(s);
        break;
      case TokenKind.KwBaseline:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.baseline = parseBaseline(s);
        break;
      case TokenKind.KwSchedule:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.schedule = parseSchedule(s);
        break;
      default:
        throw new Error(`Unexpected token in evaluation '${name}': ${tok.kind} at ${tok.loc.line}:${tok.loc.column}`);
    }
  }

  s.expect(TokenKind.RBrace, "}");
  return node;
}

function parseCaseList(s: TokenStream): AST.EvaluationCaseNode[] {
  s.expect(TokenKind.LBracket, "[");
  const cases: AST.EvaluationCaseNode[] = [];
  if (!s.check(TokenKind.RBracket)) {
    do {
      cases.push(parseCase(s));
    } while (s.match(TokenKind.Comma));
  }
  s.expect(TokenKind.RBracket, "]");
  return cases;
}

function parseCase(s: TokenStream): AST.EvaluationCaseNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.LBrace, "{");
  let caseName = "";
  const inputBindings: AST.EvaluationInputBinding[] = [];
  const expectations: AST.EvaluationExpectationNode[] = [];

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    // case-level "name:" — accept either the identifier `name` or a bare
    // identifier shaped key. We use a soft-match because `name` isn't a
    // reserved keyword anywhere else in the grammar.
    if (tok.kind === TokenKind.Identifier && tok.value === "name") {
      s.advance(); s.expect(TokenKind.Colon, ":");
      caseName = parseStringLiteral(s, "case name");
      s.match(TokenKind.Comma);
      continue;
    }
    if (tok.kind === TokenKind.KwInput) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      s.expect(TokenKind.LBrace, "{");
      while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
        const ploc = s.peek().loc;
        const param = s.expect(TokenKind.Identifier, "input param name").value;
        s.expect(TokenKind.Colon, ":");
        const value = parseExpr(s);
        inputBindings.push({ kind: "EvaluationInputBinding", loc: ploc, param, value });
        s.match(TokenKind.Comma); // optional separator
      }
      s.expect(TokenKind.RBrace, "}");
      s.match(TokenKind.Comma);
      continue;
    }
    if (tok.kind === TokenKind.KwExpected) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      s.expect(TokenKind.LBrace, "{");
      while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
        expectations.push(parseExpectation(s));
        // Allow optional comma between expectations.
        s.match(TokenKind.Comma);
      }
      s.expect(TokenKind.RBrace, "}");
      s.match(TokenKind.Comma);
      continue;
    }
    throw new Error(`Unexpected token in evaluation case: ${tok.kind} at ${tok.loc.line}:${tok.loc.column}`);
  }

  s.expect(TokenKind.RBrace, "}");
  return { kind: "EvaluationCase", loc, caseName, input: inputBindings, expectations };
}

function parseExpectation(s: TokenStream): AST.EvaluationExpectationNode {
  const tok = s.peek();
  switch (tok.kind) {
    case TokenKind.KwPasses: {
      const loc = tok.loc;
      s.advance(); s.expect(TokenKind.Colon, ":");
      const modeTok = s.peek();
      let mode: "ast_compiles" | "schema_only";
      if (modeTok.kind === TokenKind.KwAstCompiles) mode = "ast_compiles";
      else if (modeTok.kind === TokenKind.KwSchemaOnly) mode = "schema_only";
      else throw new Error(`Unexpected passes mode: ${modeTok.kind} at ${modeTok.loc.line}:${modeTok.loc.column}`);
      s.advance();
      return { kind: "ExpPasses", mode, loc };
    }
    case TokenKind.KwContainsClassNamed: {
      const loc = tok.loc;
      s.advance(); s.expect(TokenKind.Colon, ":");
      const pattern = parseStringLiteral(s, "regex pattern");
      return { kind: "ExpContainsClassNamed", pattern, loc };
    }
    case TokenKind.KwMustContainString: {
      const loc = tok.loc;
      s.advance(); s.expect(TokenKind.Colon, ":");
      const values = parseStringList(s);
      return { kind: "ExpMustContainString", values, loc };
    }
    case TokenKind.KwMustNotContainString: {
      const loc = tok.loc;
      s.advance(); s.expect(TokenKind.Colon, ":");
      const values = parseStringList(s);
      return { kind: "ExpMustNotContainString", values, loc };
    }
    case TokenKind.KwImportsOnlyFrom: {
      const loc = tok.loc;
      s.advance(); s.expect(TokenKind.Colon, ":");
      const allowed = parseStringList(s);
      return { kind: "ExpImportsOnlyFrom", allowed, loc };
    }
    case TokenKind.KwMaxLines: {
      const loc = tok.loc;
      s.advance(); s.expect(TokenKind.Colon, ":");
      const value = parseIntLiteral(s, "max_lines");
      return { kind: "ExpMaxLines", value, loc };
    }
    case TokenKind.KwMinLines: {
      const loc = tok.loc;
      s.advance(); s.expect(TokenKind.Colon, ":");
      const value = parseIntLiteral(s, "min_lines");
      return { kind: "ExpMinLines", value, loc };
    }
    case TokenKind.KwLatencyUnderMs: {
      const loc = tok.loc;
      s.advance(); s.expect(TokenKind.Colon, ":");
      const value = parseIntLiteral(s, "latency_under_ms");
      return { kind: "ExpLatencyUnderMs", value, loc };
    }
    default:
      throw new Error(`Unexpected expectation: ${tok.kind} at ${tok.loc.line}:${tok.loc.column}`);
  }
}

function parseMetric(s: TokenStream): AST.EvaluationMetricNode {
  const loc = s.peek().loc;
  const tok = s.peek();
  // Currently only `pass_rate` is supported. Reading via KwPassRate keeps
  // the grammar uniform with the rest of the cognition layer.
  if (tok.kind === TokenKind.KwPassRate) {
    s.advance();
    return { kind: "EvaluationMetric", loc, metric: "pass_rate" };
  }
  throw new Error(`Unsupported metric '${tok.value}' at ${tok.loc.line}:${tok.loc.column}; expected 'pass_rate'`);
}

function parseBaseline(s: TokenStream): AST.EvaluationBaselineNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.LBrace, "{");
  let minPassRate = 0;
  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    if (tok.kind === TokenKind.KwMinPassRate) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      minPassRate = parseFloatLiteral(s, "min_pass_rate");
    } else {
      throw new Error(`Unexpected baseline field: ${tok.kind} at ${tok.loc.line}:${tok.loc.column}`);
    }
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");
  return { kind: "EvaluationBaseline", loc, minPassRate };
}

function parseSchedule(s: TokenStream): AST.EvaluationScheduleNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.LBrace, "{");
  let on: string[] = [];
  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    if (tok.kind === TokenKind.KwOn) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      on = parseStringList(s);
    } else {
      throw new Error(`Unexpected schedule field: ${tok.kind} at ${tok.loc.line}:${tok.loc.column}`);
    }
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");
  return { kind: "EvaluationSchedule", loc, on };
}
