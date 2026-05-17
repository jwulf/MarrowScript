/**
 * MarrowScript Declaration Parsers — Cognition Layer (LLM Harness, Phase 1)
 *
 * Adds three new top-level declarations:
 *   - model    — declares an LLM adapter and its budget envelope
 *   - prompt   — declares a typed prompt with execution policy
 *   - router   — declares a deterministic routing decision tree
 *
 * Design notes:
 *   - Field-position parsing accepts keywords as identifiers via parseIdentValue,
 *     mirroring the permissive style used elsewhere in parse_decls.ts. This
 *     lets us add new keywords (template, cache, tier, ...) without breaking
 *     legitimate identifier uses.
 *   - All three parsers follow the same shape as parseEntityDecl /
 *     parseStoreDecl: open brace, switch on field-keyword tokens, close brace.
 *   - Determinism: declaration order is preserved verbatim. No `new Date()`,
 *     no `Math.random()`. Two parses of the same source produce identical ASTs.
 */

import { TokenKind } from "./lexer";
import { TokenStream, ParseError } from "./parser_base";
import * as AST from "./ast";
import { parseExpr } from "./parse_expr";
import { parseTypeExpr } from "./parse_types";
import { parseDuration } from "./parse_decls";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Read an identifier-shaped value (identifier OR any keyword token whose
 * lexeme is identifier-shaped). Used wherever the grammar expects a name
 * but we want to allow new keywords to slip through without breaking
 * existing programs.
 */
function parseIdentValue(s: TokenStream, context: string): string {
  const tok = s.peek();
  if (tok.kind === TokenKind.Identifier) return s.advance().value;
  if (tok.value && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tok.value) && tok.kind !== TokenKind.EOF) {
    return s.advance().value;
  }
  throw new ParseError(`Expected ${context}, got ${tok.kind}`, tok.loc);
}

/** Read a string literal value. */
function parseStringLiteral(s: TokenStream, context: string): string {
  return s.expect(TokenKind.StringLiteral, context).value;
}

/** Read a non-negative integer literal value. */
function parseIntLiteral(s: TokenStream, context: string): number {
  return parseInt(s.expect(TokenKind.IntLiteral, context).value, 10);
}

/** Read a float OR integer literal as a number. */
function parseNumberLiteral(s: TokenStream, context: string): number {
  const tok = s.peek();
  if (tok.kind === TokenKind.IntLiteral) {
    s.advance();
    return parseInt(tok.value, 10);
  }
  if (tok.kind === TokenKind.FloatLiteral) {
    s.advance();
    return parseFloat(tok.value);
  }
  throw new ParseError(`Expected ${context}, got ${tok.kind}`, tok.loc);
}

// ─── model ───────────────────────────────────────────────────────────────────
//
//   model TinyClassifier {
//     provider: ollama
//     name: "qwen2.5-coder:1.5b"
//     context_window: 32000
//     max_output: 512
//     temperature: 0.0
//     cost_class: tiny
//     latency_class: fast
//   }

export function parseModelDecl(s: TokenStream): AST.ModelDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwModel, "model");
  const name = s.expect(TokenKind.Identifier, "model name").value;
  s.expect(TokenKind.LBrace, "{");

  const node: AST.ModelDeclNode = {
    kind: "ModelDecl", loc, name,
    provider: null, modelName: null, endpoint: null,
    contextWindow: null, maxOutput: null, temperature: null, topP: null,
    stop: null, costClass: null, latencyClass: null,
    vramMb: null, quant: null,
  };

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    switch (tok.kind) {
      case TokenKind.KwProvider:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.provider = parseProviderKind(s);
        break;
      case TokenKind.KwEndpoint:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.endpoint = parseStringLiteral(s, "endpoint URL");
        break;
      case TokenKind.KwContextWindow:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.contextWindow = parseIntLiteral(s, "context_window");
        break;
      case TokenKind.KwMaxOutput:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.maxOutput = parseIntLiteral(s, "max_output");
        break;
      case TokenKind.KwTemperature:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.temperature = parseNumberLiteral(s, "temperature");
        break;
      case TokenKind.KwTopP:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.topP = parseNumberLiteral(s, "top_p");
        break;
      case TokenKind.KwStop:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.stop = parseStringList(s);
        break;
      case TokenKind.KwCostClass:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.costClass = parseCostClass(s);
        break;
      case TokenKind.KwLatencyClass:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.latencyClass = parseLatencyClass(s);
        break;
      case TokenKind.KwVramMb:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.vramMb = parseIntLiteral(s, "vram_mb");
        break;
      case TokenKind.KwQuant:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.quant = parseIdentValue(s, "quant tag");
        break;
      // `name:` is a builtin keyword-like ident in this position.
      default:
        if (tok.kind === TokenKind.Identifier && tok.value === "name") {
          s.advance(); s.expect(TokenKind.Colon, ":");
          node.modelName = parseStringLiteral(s, "model name string");
          break;
        }
        throw new ParseError(`Unexpected in model: ${tok.kind} ('${tok.value}')`, tok.loc);
    }
    // Optional comma between fields. Both styles are accepted:
    //   "provider: ollama, name: ..."   and   "provider: ollama\n name: ..."
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");
  return node;
}

function parseProviderKind(s: TokenStream): AST.ProviderKind {
  const tok = s.peek();
  // Providers are spelled as identifiers (no dedicated tokens) to keep the
  // catalog open to extension via the parser, while the type checker enforces
  // membership.
  const v = parseIdentValue(s, "provider");
  const valid: AST.ProviderKind[] = ["openai_compat", "ollama", "llamacpp", "koboldcpp", "http"];
  if (!valid.includes(v as AST.ProviderKind)) {
    throw new ParseError(
      `Unknown provider '${v}'. Expected one of: ${valid.join(", ")}`,
      tok.loc,
    );
  }
  return v as AST.ProviderKind;
}

function parseCostClass(s: TokenStream): AST.CostClass {
  const tok = s.peek();
  switch (tok.kind) {
    case TokenKind.KwTiny: s.advance(); return "tiny";
    case TokenKind.KwSmall: s.advance(); return "small";
    case TokenKind.KwMedium: s.advance(); return "medium";
    case TokenKind.KwLarge: s.advance(); return "large";
    default:
      throw new ParseError(
        `Expected cost_class (tiny|small|medium|large), got ${tok.kind} ('${tok.value}')`,
        tok.loc,
      );
  }
}

function parseLatencyClass(s: TokenStream): AST.LatencyClass {
  const tok = s.peek();
  // "fast" reuses no existing keyword — treat as identifier
  if (tok.kind === TokenKind.Identifier && tok.value === "fast") {
    s.advance();
    return "fast";
  }
  if (tok.kind === TokenKind.KwMedium) { s.advance(); return "medium"; }
  if (tok.kind === TokenKind.KwSlow) { s.advance(); return "slow"; }
  throw new ParseError(
    `Expected latency_class (fast|medium|slow), got ${tok.kind} ('${tok.value}')`,
    tok.loc,
  );
}

function parseStringList(s: TokenStream): string[] {
  s.expect(TokenKind.LBracket, "[");
  const items: string[] = [];
  if (!s.check(TokenKind.RBracket)) {
    do {
      items.push(parseStringLiteral(s, "string"));
    } while (s.match(TokenKind.Comma));
  }
  s.expect(TokenKind.RBracket, "]");
  return items;
}

// ─── prompt ──────────────────────────────────────────────────────────────────
//
//   prompt classify_task(task: string) {
//     model: TinyClassifier
//     template: "extension_point:tmpl_classify_task"
//     returns: enum<["analyze","plan"]>     // any TypeExpr
//     timeout: 5s
//     cache: { key: hash(task), ttl: 1h }
//     retry: { max_attempts: 2, backoff: fixed, interval: 200ms }
//     idempotent: true
//     validate: schema_only
//     on_invalid: retry_with_repair_prompt
//     constraints: [output.length <= 256]
//     tools: [foo, bar]
//   }

export function parsePromptDecl(s: TokenStream): AST.PromptDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwPrompt, "prompt");
  const name = s.expect(TokenKind.Identifier, "prompt name").value;

  // Param list (same as capability)
  s.expect(TokenKind.LParen, "(");
  const params: AST.ParamNode[] = [];
  if (!s.check(TokenKind.RParen)) {
    do {
      const ploc = s.peek().loc;
      const pname = parseIdentValue(s, "param name");
      s.expect(TokenKind.Colon, ":");
      const ptype = parseTypeExpr(s);
      params.push({ kind: "Param", loc: ploc, name: pname, type: ptype });
    } while (s.match(TokenKind.Comma));
  }
  s.expect(TokenKind.RParen, ")");
  s.expect(TokenKind.LBrace, "{");

  const node: AST.PromptDeclNode = {
    kind: "PromptDecl", loc, name, params,
    returns: null,
    modelRef: null, routerRef: null, template: null,
    validate: { kind: "none" },
    onInvalid: "fail",
    retry: null, timeout: null, cache: null, idempotent: null,
    constraints: [],
    allowedTools: [],
    promptbookRef: null,
    promptbookArgs: [],
  };

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    switch (tok.kind) {
      case TokenKind.KwModel:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.modelRef = s.expect(TokenKind.Identifier, "model reference").value;
        break;
      case TokenKind.KwRouter:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.routerRef = s.expect(TokenKind.Identifier, "router reference").value;
        break;
      case TokenKind.KwTemplate:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.template = parseStringLiteral(s, "template string");
        break;
      case TokenKind.KwReturns:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.returns = parseTypeExpr(s);
        break;
      case TokenKind.KwTimeout:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.timeout = parseDuration(s);
        break;
      case TokenKind.KwIdempotent:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.idempotent = s.advance().kind === TokenKind.KwTrue;
        break;
      case TokenKind.KwRetry:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.retry = parseRetryPolicyInline(s);
        break;
      case TokenKind.KwValidate:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.validate = parseValidateMode(s);
        break;
      case TokenKind.KwOnInvalid:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.onInvalid = parseOnInvalidAction(s);
        break;
      case TokenKind.KwCache:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.cache = parsePromptCache(s);
        break;
      case TokenKind.KwConstraints:
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.LBracket, "[");
        if (!s.check(TokenKind.RBracket)) {
          do { node.constraints.push(parseExpr(s)); } while (s.match(TokenKind.Comma));
        }
        s.expect(TokenKind.RBracket, "]");
        break;
      case TokenKind.KwTools:
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.LBracket, "[");
        if (!s.check(TokenKind.RBracket)) {
          do {
            node.allowedTools.push(s.expect(TokenKind.Identifier, "tool capability name").value);
          } while (s.match(TokenKind.Comma));
        }
        s.expect(TokenKind.RBracket, "]");
        break;
      case TokenKind.KwPromptbook:
        // Phase 18: promptbook reference. Mutually exclusive with `template:`.
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.promptbookRef = s.expect(TokenKind.Identifier, "promptbook entry name").value;
        break;
      case TokenKind.KwWith:
        // Phase 18: parameter bindings for the promptbook entry.
        // Shape: with: { name1: "value", name2: 42, ... }
        // Comma between bindings is optional (newline counts).
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.LBrace, "{");
        while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
          const argName = s.expect(TokenKind.Identifier, "promptbook arg name").value;
          s.expect(TokenKind.Colon, ":");
          const argValue = parseExpr(s);
          node.promptbookArgs.push({ name: argName, value: argValue });
          s.match(TokenKind.Comma); // optional separator
        }
        s.expect(TokenKind.RBrace, "}");
        break;
      default:
        throw new ParseError(`Unexpected in prompt: ${tok.kind} ('${tok.value}')`, tok.loc);
    }
    // Optional comma between fields.
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");
  return node;
}

function parseValidateMode(s: TokenStream): AST.ValidateMode {
  const tok = s.peek();
  switch (tok.kind) {
    case TokenKind.KwNone: s.advance(); return { kind: "none" };
    case TokenKind.KwSchemaOnly: s.advance(); return { kind: "schema_only" };
    case TokenKind.KwAstCompiles: s.advance(); return { kind: "ast_compiles" };
    case TokenKind.KwCustom: {
      s.advance();
      s.expect(TokenKind.Colon, ":");
      const ep = s.expect(TokenKind.Identifier, "extension_point name").value;
      return { kind: "custom", extensionPoint: ep };
    }
    default:
      throw new ParseError(
        `Expected validate mode (none|schema_only|ast_compiles|custom:NAME), got ${tok.kind}`,
        tok.loc,
      );
  }
}

function parseOnInvalidAction(s: TokenStream): AST.OnInvalidAction {
  const tok = s.peek();
  switch (tok.kind) {
    case TokenKind.KwFail: s.advance(); return "fail";
    case TokenKind.KwRetry: s.advance(); return "retry";
    case TokenKind.KwRetryWithRepairPrompt: s.advance(); return "retry_with_repair_prompt";
    case TokenKind.KwEscalate: s.advance(); return "escalate";
    default:
      throw new ParseError(
        `Expected on_invalid action (fail|retry|retry_with_repair_prompt|escalate), got ${tok.kind}`,
        tok.loc,
      );
  }
}

function parsePromptCache(s: TokenStream): AST.PromptCacheNode {
  s.expect(TokenKind.LBrace, "{");
  let keyExpr: AST.ExprNode | null = null;
  let ttl: string | null = null;

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    // `key` is not a dedicated keyword — it is an identifier in this position.
    if (tok.kind === TokenKind.Identifier && tok.value === "key") {
      s.advance(); s.expect(TokenKind.Colon, ":");
      keyExpr = parseExpr(s);
    } else if (tok.kind === TokenKind.KwTtl) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      ttl = parseDuration(s);
    } else {
      throw new ParseError(`Unexpected in cache: ${tok.kind} ('${tok.value}')`, tok.loc);
    }
    if (!s.match(TokenKind.Comma)) break;
  }
  s.expect(TokenKind.RBrace, "}");
  return { kind: "PromptCache", keyExpr, ttl };
}

/**
 * Inline retry policy: { max_attempts: N, backoff: <ident>, interval: <dur> }.
 * Mirrors parseRetryPolicy in parse_decls.ts but is duplicated here to keep
 * the cognition parsers self-contained and to avoid widening parse_decls.ts's
 * export surface.
 */
function parseRetryPolicyInline(s: TokenStream): AST.RetryPolicyNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.LBrace, "{");
  const node: AST.RetryPolicyNode = {
    kind: "RetryPolicy", loc,
    maxAttempts: null, backoff: null, interval: null,
  };
  while (!s.check(TokenKind.RBrace)) {
    const tok = s.peek();
    if (tok.kind === TokenKind.KwMaxAttempts) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      node.maxAttempts = parseIntLiteral(s, "max_attempts");
    } else if (tok.kind === TokenKind.KwBackoff) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      node.backoff = s.advance().value;
    } else if (tok.kind === TokenKind.KwInterval) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      node.interval = parseDuration(s);
    } else {
      throw new ParseError(`Unexpected in retry: ${tok.kind}`, tok.loc);
    }
    if (!s.match(TokenKind.Comma)) break;
  }
  s.expect(TokenKind.RBrace, "}");
  return node;
}

// ─── router ──────────────────────────────────────────────────────────────────
//
//   router cheapest_valid {
//     by: input.complexity
//     tier tiny   { max: 0.2 -> TinyClassifier }
//     tier small  { max: 0.6 -> SmallSummarizer }
//     tier medium {           -> MediumSynthesizer }
//     on_low_confidence: escalate
//     confidence_threshold: 0.65
//     fallback: SmallSummarizer
//   }

export function parseRouterDecl(s: TokenStream): AST.RouterDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwRouter, "router");
  const name = s.expect(TokenKind.Identifier, "router name").value;
  s.expect(TokenKind.LBrace, "{");

  const node: AST.RouterDeclNode = {
    kind: "RouterDecl", loc, name,
    byExpr: null,
    tiers: [],
    onLowConfidence: "escalate",
    confidenceThreshold: null,
    fallbackModel: null,
    observe: [],
    policy: null,
  };

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    switch (tok.kind) {
      case TokenKind.KwBy:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.byExpr = parseExpr(s);
        break;
      case TokenKind.KwTier:
        node.tiers.push(parseRouterTier(s));
        break;
      case TokenKind.KwOnLowConfidence: {
        s.advance(); s.expect(TokenKind.Colon, ":");
        const t = s.peek();
        if (t.kind === TokenKind.KwFail) { s.advance(); node.onLowConfidence = "fail"; }
        else if (t.kind === TokenKind.KwEscalate) { s.advance(); node.onLowConfidence = "escalate"; }
        else if (t.kind === TokenKind.KwRetry) { s.advance(); node.onLowConfidence = "retry"; }
        else throw new ParseError(
          `Expected on_low_confidence action (fail|escalate|retry), got ${t.kind}`,
          t.loc,
        );
        break;
      }
      case TokenKind.KwConfidenceThreshold:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.confidenceThreshold = parseNumberLiteral(s, "confidence_threshold");
        break;
      case TokenKind.KwFallback:
        s.advance(); s.expect(TokenKind.Colon, ":");
        node.fallbackModel = s.expect(TokenKind.Identifier, "fallback model").value;
        break;
      case TokenKind.KwObserve:
        // Phase 19: list of metric names the runtime should record.
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.LBracket, "[");
        if (!s.check(TokenKind.RBracket)) {
          do { node.observe.push(s.expect(TokenKind.StringLiteral, "metric name").value); } while (s.match(TokenKind.Comma));
        }
        s.expect(TokenKind.RBracket, "]");
        break;
      case TokenKind.KwPolicy: {
        // Phase 19: policy: minimize_cost_subject_to { <constraints> }
        const policyLoc = tok.loc;
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.KwMinimizeCostSubjectTo, "minimize_cost_subject_to");
        s.expect(TokenKind.LBrace, "{");
        const constraints: AST.ExprNode[] = [];
        while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
          constraints.push(parseExpr(s));
          // Comma is optional between constraint expressions.
          s.match(TokenKind.Comma);
        }
        s.expect(TokenKind.RBrace, "}");
        node.policy = {
          kind: "RouterPolicy",
          loc: policyLoc,
          objective: "minimize_cost_subject_to",
          constraints,
        };
        break;
      }
      default:
        throw new ParseError(`Unexpected in router: ${tok.kind} ('${tok.value}')`, tok.loc);
    }
    // Optional comma between fields.
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");
  return node;
}

function parseRouterTier(s: TokenStream): AST.RouterTierNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwTier, "tier");
  const name = parseIdentValue(s, "tier name");
  s.expect(TokenKind.LBrace, "{");

  let max: number | null = null;
  let modelRef: string | null = null;

  // Two shapes inside the tier body:
  //   max: 0.2 -> Model
  //   -> Model            (default tier; max is null)
  //
  // We accept them in either order, and we tolerate optional commas.
  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    if (tok.kind === TokenKind.KwMax) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      max = parseNumberLiteral(s, "max");
    } else if (tok.kind === TokenKind.Arrow) {
      s.advance();
      modelRef = s.expect(TokenKind.Identifier, "tier model reference").value;
    } else {
      throw new ParseError(`Unexpected in tier: ${tok.kind} ('${tok.value}')`, tok.loc);
    }
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");

  if (modelRef === null) {
    throw new ParseError(`Tier '${name}' is missing -> <Model>`, loc);
  }

  return { kind: "RouterTier", loc, name, max, modelRef };
}
