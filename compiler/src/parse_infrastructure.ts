/**
 * MarrowScript Declaration Parsers â€” Channel, Store, Event, Constraint, Policy, Flow, Import
 */

import { TokenKind } from "./lexer";
import { TokenStream, ParseError } from "./parser_base";
import * as AST from "./ast";
import { parseExpr } from "./parse_expr";
import { parseTypeExpr } from "./parse_types";
import { parseFieldList, parseDuration, parseIdentList } from "./parse_decls";

// â”€â”€â”€ Channel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function parseChannelDecl(s: TokenStream): AST.ChannelDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwChannel, "channel");
  const name = s.expect(TokenKind.Identifier, "name").value;
  s.expect(TokenKind.LBrace, "{");

  const node: AST.ChannelDeclNode = {
    kind: "ChannelDecl", loc, name,
    transport: null, ordering: null, participants: null,
    persistence: null, filter: null, maxSize: null,
  };

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    switch (tok.kind) {
      case TokenKind.KwTransport: s.advance(); s.expect(TokenKind.Colon, ":"); node.transport = s.advance().value; break;
      case TokenKind.KwOrdering: s.advance(); s.expect(TokenKind.Colon, ":"); node.ordering = s.advance().value; break;
      case TokenKind.KwParticipants: s.advance(); s.expect(TokenKind.Colon, ":"); node.participants = parseTypeExpr(s); break;
      case TokenKind.KwPersistence: s.advance(); s.expect(TokenKind.Colon, ":"); node.persistence = s.advance().value; break;
      case TokenKind.KwFilter: s.advance(); s.expect(TokenKind.Colon, ":"); node.filter = parseExpr(s); break;
      case TokenKind.KwMaxSize: s.advance(); s.expect(TokenKind.Colon, ":"); node.maxSize = parseInt(s.expect(TokenKind.IntLiteral, "n").value, 10); break;
      default: throw new ParseError(`Unexpected in channel: ${tok.kind}`, tok.loc);
    }
  }
  s.expect(TokenKind.RBrace, "}");
  return node;
}

// â”€â”€â”€ Store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function parseStoreDecl(s: TokenStream): AST.StoreDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwStore, "store");
  const name = s.expect(TokenKind.Identifier, "name").value;
  s.expect(TokenKind.LBrace, "{");

  const node: AST.StoreDeclNode = {
    kind: "StoreDecl", loc, name,
    engine: null, schema: [], retention: null, partition: null, replicas: null,
  };

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    switch (tok.kind) {
      case TokenKind.KwEngine: s.advance(); s.expect(TokenKind.Colon, ":"); node.engine = s.advance().value; break;
      case TokenKind.KwSchema:
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.LBrace, "{");
        node.schema = parseFieldList(s);
        s.expect(TokenKind.RBrace, "}");
        break;
      case TokenKind.KwRetention: s.advance(); s.expect(TokenKind.Colon, ":"); node.retention = parseDuration(s); break;
      case TokenKind.KwPartition: s.advance(); s.expect(TokenKind.Colon, ":"); node.partition = s.expect(TokenKind.Identifier, "field").value; break;
      case TokenKind.KwReplicas: s.advance(); s.expect(TokenKind.Colon, ":"); node.replicas = parseInt(s.expect(TokenKind.IntLiteral, "n").value, 10); break;
      default: throw new ParseError(`Unexpected in store: ${tok.kind}`, tok.loc);
    }
  }
  s.expect(TokenKind.RBrace, "}");
  return node;
}

// â”€â”€â”€ Event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function parseEventDecl(s: TokenStream): AST.EventDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwEvent, "event");
  const name = s.expect(TokenKind.Identifier, "name").value;
  s.expect(TokenKind.LBrace, "{");

  const node: AST.EventDeclNode = {
    kind: "EventDecl", loc, name, payload: [], delivery: null, ttl: null,
  };

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    switch (tok.kind) {
      case TokenKind.KwPayload:
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.LBrace, "{");
        node.payload = parseFieldList(s);
        s.expect(TokenKind.RBrace, "}");
        break;
      case TokenKind.KwDelivery: s.advance(); s.expect(TokenKind.Colon, ":"); node.delivery = s.advance().value; break;
      case TokenKind.KwTtl: s.advance(); s.expect(TokenKind.Colon, ":"); node.ttl = parseDuration(s); break;
      default: throw new ParseError(`Unexpected in event: ${tok.kind}`, tok.loc);
    }
  }
  s.expect(TokenKind.RBrace, "}");
  return node;
}

// â”€â”€â”€ Constraint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function parseConstraintDecl(s: TokenStream): AST.ConstraintDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwConstraint, "constraint");
  const name = s.expect(TokenKind.Identifier, "name").value;
  s.expect(TokenKind.Colon, ":");
  const expr = parseExpr(s);
  return { kind: "ConstraintDecl", loc, name, expr };
}

// â”€â”€â”€ Policy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function parsePolicyDecl(s: TokenStream): AST.PolicyDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwPolicy, "policy");
  const name = s.expect(TokenKind.Identifier, "name").value;
  s.expect(TokenKind.LBrace, "{");

  const node: AST.PolicyDeclNode = {
    kind: "PolicyDecl", loc, name, rateLimit: null, access: [], audit: null, encryption: null,
    costBudgets: [],
  };

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    switch (tok.kind) {
      case TokenKind.KwRateLimit:
        s.advance(); s.expect(TokenKind.Colon, ":");
        const count = parseInt(s.expect(TokenKind.IntLiteral, "count").value, 10);
        s.expect(TokenKind.KwPer, "per");
        const per = parseDuration(s);
        node.rateLimit = { count, per };
        break;
      case TokenKind.KwAccess:
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.LBracket, "[");
        node.access = parseIdentList(s);
        s.expect(TokenKind.RBracket, "]");
        break;
      case TokenKind.KwAudit: s.advance(); s.expect(TokenKind.Colon, ":"); node.audit = s.advance().kind === TokenKind.KwTrue; break;
      case TokenKind.KwEncryption: s.advance(); s.expect(TokenKind.Colon, ":"); node.encryption = s.advance().value; break;
      case TokenKind.KwCostBudgets:
        s.advance(); s.expect(TokenKind.Colon, ":");
        s.expect(TokenKind.LBracket, "[");
        if (!s.check(TokenKind.RBracket)) {
          do { node.costBudgets.push(parseCostBudget(s)); } while (s.match(TokenKind.Comma));
        }
        s.expect(TokenKind.RBracket, "]");
        break;
      default: throw new ParseError(`Unexpected in policy: ${tok.kind}`, tok.loc);
    }
  }
  s.expect(TokenKind.RBrace, "}");
  return node;
}

/**
 * Phase 21: parse one cost-budget object literal. Shape:
 *   { scope: per_tenant, window: 1d, cap_usd: 5.00, on_exceeded: { action: error, code: "X" } }
 *   { scope: per_feature: "foo", window: 1h, cap_calls: 10, on_exceeded: { action: throttle, retry_after: 30s } }
 */
function parseCostBudget(s: TokenStream): AST.CostBudgetNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.LBrace, "{");
  let scope: "per_tenant" | "per_user" | "per_feature" | null = null;
  let feature: string | null = null;
  let window = "";
  let capUsd: number | null = null;
  let capTokens: number | null = null;
  let capCalls: number | null = null;
  let action: "error" | "throttle" = "error";
  let retryAfter: string | null = null;
  let errorCode: string | null = null;

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    // `scope`, `window`, `action`, `code`, `error` aren't reserved keywords
    // (too commonly used as user identifiers — `prompt code(text)`, `error:` etc.).
    // Inside the cost-budget body we treat them as contextual field names by
    // matching on the token's identifier string.
    if (tok.kind === TokenKind.Identifier && tok.value === "scope") {
      s.advance(); s.expect(TokenKind.Colon, ":");
      const t = s.peek();
      if (t.kind === TokenKind.KwPerTenant) { s.advance(); scope = "per_tenant"; }
      else if (t.kind === TokenKind.KwPerUser) { s.advance(); scope = "per_user"; }
      else if (t.kind === TokenKind.KwPerFeature) {
        s.advance();
        s.expect(TokenKind.Colon, ":");
        feature = s.expect(TokenKind.StringLiteral, "feature name").value;
        scope = "per_feature";
      } else {
        throw new ParseError(`Unexpected scope token: ${t.kind} (expected per_tenant, per_user, or per_feature)`, t.loc);
      }
    } else if (tok.kind === TokenKind.Identifier && tok.value === "window") {
      s.advance(); s.expect(TokenKind.Colon, ":");
      window = parseDuration(s);
    } else if (tok.kind === TokenKind.KwCapUsd) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      const t = s.peek();
      if (t.kind === TokenKind.FloatLiteral) { s.advance(); capUsd = parseFloat(t.value); }
      else if (t.kind === TokenKind.IntLiteral) { s.advance(); capUsd = parseInt(t.value, 10); }
      else throw new ParseError(`Expected number for cap_usd, got ${t.kind}`, t.loc);
    } else if (tok.kind === TokenKind.KwCapTokens) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      capTokens = parseInt(s.expect(TokenKind.IntLiteral, "cap_tokens").value, 10);
    } else if (tok.kind === TokenKind.KwCapCalls) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      capCalls = parseInt(s.expect(TokenKind.IntLiteral, "cap_calls").value, 10);
    } else if (tok.kind === TokenKind.KwOnExceeded) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      s.expect(TokenKind.LBrace, "{");
      while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
        const sub = s.peek();
        if (sub.kind === TokenKind.Identifier && sub.value === "action") {
          s.advance(); s.expect(TokenKind.Colon, ":");
          const a = s.peek();
          if (a.kind === TokenKind.KwThrottle) { s.advance(); action = "throttle"; }
          else if (a.kind === TokenKind.Identifier && a.value === "error") { s.advance(); action = "error"; }
          else throw new ParseError(`Unexpected action: ${a.value} (expected throttle or error)`, a.loc);
        } else if (sub.kind === TokenKind.KwRetryAfter) {
          s.advance(); s.expect(TokenKind.Colon, ":");
          retryAfter = parseDuration(s);
        } else if (sub.kind === TokenKind.Identifier && sub.value === "code") {
          s.advance(); s.expect(TokenKind.Colon, ":");
          errorCode = s.expect(TokenKind.StringLiteral, "error code").value;
        } else {
          throw new ParseError(`Unexpected on_exceeded field: ${sub.kind} ('${sub.value}')`, sub.loc);
        }
        s.match(TokenKind.Comma);
      }
      s.expect(TokenKind.RBrace, "}");
    } else {
      throw new ParseError(`Unexpected cost_budget field: ${tok.kind} ('${tok.value}')`, tok.loc);
    }
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");

  if (!scope) throw new ParseError("cost_budget requires a scope (per_tenant | per_user | per_feature)", loc);
  if (!window) throw new ParseError("cost_budget requires a window", loc);

  return { kind: "CostBudget", loc, scope, feature, window, capUsd, capTokens, capCalls, action, retryAfter, errorCode };
}

// â”€â”€â”€ Flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function parseFlowDecl(s: TokenStream): AST.FlowDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwFlow, "flow");
  const name = s.expect(TokenKind.Identifier, "name").value;
  s.expect(TokenKind.LBrace, "{");

  const steps: AST.FlowStepNode[] = [];
  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const sloc = s.peek().loc;
    s.expect(TokenKind.KwStep, "step");
    // Step names allow keyword-shaped identifiers (e.g. "validate") since the
    // language has many reserved words and step names are user-chosen labels
    // with no syntactic significance beyond identification.
    const stepNameTok = s.peek();
    let stepName: string;
    if (stepNameTok.kind === TokenKind.Identifier) {
      stepName = s.advance().value;
    } else if (stepNameTok.value && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(stepNameTok.value) && stepNameTok.kind !== TokenKind.EOF) {
      stepName = s.advance().value;
    } else {
      throw new ParseError(`Expected step name, got ${stepNameTok.kind}`, stepNameTok.loc);
    }
    s.expect(TokenKind.Colon, ":");
    const action = parseCallExpr(s);
    let compensate: AST.CallExprNode | null = null;
    let checkpoint: AST.FlowCheckpointNode | null = null;
    // Loop over post-action clauses (compensate, checkpoint). Order is
    // arbitrary so users can write either compensate-then-checkpoint or
    // checkpoint-then-compensate.
    while (true) {
      if (s.check(TokenKind.KwCompensate)) {
        s.advance(); s.expect(TokenKind.Colon, ":");
        compensate = parseCallExpr(s);
        continue;
      }
      if (s.check(TokenKind.KwCheckpoint)) {
        checkpoint = parseFlowCheckpoint(s);
        continue;
      }
      break;
    }
    steps.push({ kind: "FlowStep", loc: sloc, name: stepName, action, compensate, checkpoint });
  }
  s.expect(TokenKind.RBrace, "}");
  return { kind: "FlowDecl", loc, name, steps };
}

/**
 * Phase 17: parse a `checkpoint: <name> { shows: [...], allow: [...], timeout: T, on_timeout: cancel }` clause.
 * The opening `checkpoint:` keyword has already been peeked but NOT consumed.
 */
function parseFlowCheckpoint(s: TokenStream): AST.FlowCheckpointNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwCheckpoint, "checkpoint");
  s.expect(TokenKind.Colon, ":");
  const name = s.expect(TokenKind.Identifier, "checkpoint name").value;
  s.expect(TokenKind.LBrace, "{");
  const shows: AST.ExprNode[] = [];
  const allow: string[] = [];
  let timeout: string | null = null;
  let onTimeout: "cancel" | null = null;

  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    if (tok.kind === TokenKind.KwShows) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      s.expect(TokenKind.LBracket, "[");
      if (!s.check(TokenKind.RBracket)) {
        do { shows.push(parseExpr(s)); } while (s.match(TokenKind.Comma));
      }
      s.expect(TokenKind.RBracket, "]");
    } else if (tok.kind === TokenKind.KwAllow) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      s.expect(TokenKind.LBracket, "[");
      if (!s.check(TokenKind.RBracket)) {
        do {
          // Each allow entry is a string literal.
          allow.push(s.expect(TokenKind.StringLiteral, "decision string").value);
        } while (s.match(TokenKind.Comma));
      }
      s.expect(TokenKind.RBracket, "]");
    } else if (tok.kind === TokenKind.KwTimeout) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      timeout = parseDuration(s);
    } else if (tok.kind === TokenKind.KwOnTimeout) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      const t = s.peek();
      if (t.kind === TokenKind.KwCancel) { s.advance(); onTimeout = "cancel"; }
      else throw new ParseError(`Unsupported on_timeout action '${t.value}' (only 'cancel' supported in v1)`, t.loc);
    } else {
      throw new ParseError(`Unexpected token in checkpoint '${name}': ${tok.kind}`, tok.loc);
    }
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");
  return { kind: "FlowCheckpoint", loc, name, shows, allow, timeout, onTimeout };
}

function parseCallExpr(s: TokenStream): AST.CallExprNode {
  const loc = s.peek().loc;
  const name = s.expect(TokenKind.Identifier, "call name").value;
  s.expect(TokenKind.LParen, "(");
  const args: AST.ExprNode[] = [];
  if (!s.check(TokenKind.RParen)) {
    do { args.push(parseExpr(s)); } while (s.match(TokenKind.Comma));
  }
  s.expect(TokenKind.RParen, ")");
  return { kind: "CallExpr", loc, name, args };
}

// â”€â”€â”€ Import â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function parseImportDecl(s: TokenStream): AST.ImportDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwImport, "import");
  const name = s.expect(TokenKind.Identifier, "name").value;
  s.expect(TokenKind.KwFrom, "from");
  const from = s.expect(TokenKind.StringLiteral, "path").value;
  return { kind: "ImportDecl", loc, name, from };
}

// ─── Extension Point ─────────────────────────────────────────────────────────

export function parseExtensionPointDecl(s: TokenStream): AST.ExtensionPointDeclNode {
  const loc = s.peek().loc;
  s.expect(TokenKind.KwExtensionPoint, "extension_point");
  const name = s.expect(TokenKind.Identifier, "extension point name").value;
  s.expect(TokenKind.LParen, "(");
  const params: AST.ParamNode[] = [];
  if (!s.check(TokenKind.RParen)) {
    do {
      const ploc = s.peek().loc;
      // Allow keywords as param names
      const pname = s.peek().kind === TokenKind.Identifier ? s.advance().value : s.advance().value;
      s.expect(TokenKind.Colon, ":");
      const ptype = parseTypeExpr(s);
      params.push({ kind: "Param", loc: ploc, name: pname, type: ptype });
    } while (s.match(TokenKind.Comma));
  }
  s.expect(TokenKind.RParen, ")");

  let returns: AST.TypeExprNode | null = null;
  let stable = false;

  s.expect(TokenKind.LBrace, "{");
  while (!s.check(TokenKind.RBrace) && !s.check(TokenKind.EOF)) {
    const tok = s.peek();
    if (tok.kind === TokenKind.KwReturns) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      returns = parseTypeExpr(s);
    } else if (tok.kind === TokenKind.KwStable) {
      s.advance(); s.expect(TokenKind.Colon, ":");
      stable = s.advance().kind === TokenKind.KwTrue;
    } else if (tok.kind === TokenKind.KwLanguage) {
      // language: typescript — consume and ignore (only TS supported)
      s.advance(); s.expect(TokenKind.Colon, ":"); s.advance();
    } else {
      throw new ParseError(`Unexpected in extension_point: ${tok.kind}`, tok.loc);
    }
    // Optional comma between fields. Both inline and newline forms are accepted.
    s.match(TokenKind.Comma);
  }
  s.expect(TokenKind.RBrace, "}");

  return { kind: "ExtensionPointDecl", loc, name, params, returns, stable };
}
