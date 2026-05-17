/**
 * MarrowScript Abstract Syntax Tree
 * Direct representation of the grammar in spec/02_GRAMMAR.peg.
 * Every node type corresponds to a grammar production.
 */

import { SourceLocation } from "./lexer";

// â”€â”€â”€ Base Node â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ASTNode {
  kind: string;
  loc: SourceLocation;
}

// â”€â”€â”€ Program â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ProgramNode extends ASTNode {
  kind: "Program";
  systems: SystemDeclNode[];
}

// â”€â”€â”€ System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SystemDeclNode extends ASTNode {
  kind: "SystemDecl";
  name: string;
  domain: string | null;
  declarations: DeclarationNode[];
}

export type DeclarationNode =
  | EntityDeclNode
  | CapabilityDeclNode
  | ChannelDeclNode
  | StoreDeclNode
  | EventDeclNode
  | ConstraintDeclNode
  | PolicyDeclNode
  | FlowDeclNode
  | ImportDeclNode
  | ExtensionPointDeclNode
  | ModelDeclNode
  | PromptDeclNode
  | RouterDeclNode
  | EvaluationDeclNode;

// â”€â”€â”€ Entity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface EntityDeclNode extends ASTNode {
  kind: "EntityDecl";
  name: string;
  owns: FieldNode[];
  constraints: ExprNode[];
  states: StateGraphNode | null;
  auth: string | null;
  relations: RelationNode[];
  indexes: string[][];
  derived: DerivedFieldNode[];
}

export interface FieldNode extends ASTNode {
  kind: "Field";
  name: string;
  type: TypeExprNode;
  defaultValue: ExprNode | null;
  renamedFrom?: string | null;
  sensitive?: boolean;
}

export interface StateGraphNode extends ASTNode {
  kind: "StateGraph";
  nodes: StateNodeEntry[];
}

export interface StateNodeEntry {
  name: string;
  guard: ExprNode | null;
  transitions: string[]; // names of states this transitions to (via ->)
  branches: string[];    // names of states this branches to (via |)
}

export interface RelationNode extends ASTNode {
  kind: "Relation";
  name: string;
  relationType: "has_one" | "has_many" | "belongs_to" | "many_to_many";
  target: string;
  cardinality: { min: number; max: number | "*" } | null;
}

export interface DerivedFieldNode extends ASTNode {
  kind: "DerivedField";
  name: string;
  expr: ExprNode;
}

// â”€â”€â”€ Capability â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface CapabilityDeclNode extends ASTNode {
  kind: "CapabilityDecl";
  name: string;
  params: ParamNode[];
  requires: ExprNode[];
  effects: EffectNode[];
  emits: EmitNode[];
  sync: string | null;
  timeout: string | null;
  retry: RetryPolicyNode | null;
  idempotent: boolean | null;
  pipeline: PipelineNode | null;
  algorithm: AlgorithmNode | null;
  cognition: CognitionNode | null;
  returns: TypeExprNode | null;
}

export interface PipelineNode extends ASTNode {
  kind: "Pipeline";
  steps: PipelineStepLike[];
  parallel: boolean;
  onError: PipelineErrorHandler | null;
}

/** A pipeline step is either a plain call+bindAs or a runtime match. */
export type PipelineStepLike = PipelineStepNode | PipelineMatchNode;

export interface PipelineStepNode extends ASTNode {
  kind: "PipelineStep";
  call: CallExprNode;
  bindAs: string | null; // optional `as <name>` to capture output
}

/**
 * Phase 11: match step. The runtime evaluates `key` once and dispatches to
 * the case whose literal value matches. Cases are case-sensitive string
 * literals or numeric literals; the optional default arm catches anything
 * else. Same input → same branch (deterministic).
 *
 *   match r.preset {
 *     case "compare_apis": gen_report(...) as artifact
 *     case "migrate":      gen_report(...) as artifact
 *     default:             gen_artifact(...) as artifact
 *   }
 *
 * Each arm is itself a regular PipelineStepNode (call + optional bindAs),
 * so cases reuse the same alias-rewrite + cognition-dispatch logic the
 * non-match path already has.
 */
export interface PipelineMatchNode extends ASTNode {
  kind: "PipelineMatch";
  key: ExprNode;            // the value compared against case literals
  cases: PipelineMatchCase[];
  defaultArm: PipelineStepNode | null;
}

export interface PipelineMatchCase {
  /** Literal value to match. Stringified at lowering time for codegen. */
  literal: string;
  /** "string" or "number" — drives equality comparison in the emit body. */
  literalKind: "string" | "number";
  /** The arm's body — a single call+bindAs, same shape as a regular step. */
  arm: PipelineStepNode;
}

export interface PipelineErrorHandler {
  kind: "PipelineErrorHandler";
  action: "rollback" | "compensate" | "ignore" | "retry";
  call: CallExprNode | null;
}

export interface AlgorithmNode extends ASTNode {
  kind: "Algorithm";
  name: string;             // catalog entry, e.g. "shortest_path"
  using: AlgorithmBinding[]; // typed parameter bindings
}

export interface AlgorithmBinding {
  param: string;
  value: ExprNode;
}

export interface ParamNode extends ASTNode {
  kind: "Param";
  name: string;
  type: TypeExprNode;
}

export interface EffectNode extends ASTNode {
  kind: "Effect";
  target: FieldRefNode;
  op: "=" | "+=" | "-=";
  value: ExprNode;
}

export interface EmitNode extends ASTNode {
  kind: "Emit";
  eventName: string;
  args: ExprNode[];
}

export interface RetryPolicyNode extends ASTNode {
  kind: "RetryPolicy";
  maxAttempts: number | null;
  backoff: string | null;
  interval: string | null;
}

// â”€â”€â”€ Channel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ChannelDeclNode extends ASTNode {
  kind: "ChannelDecl";
  name: string;
  transport: string | null;
  ordering: string | null;
  participants: TypeExprNode | null;
  persistence: string | null;
  filter: ExprNode | null;
  maxSize: number | null;
}

// â”€â”€â”€ Store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface StoreDeclNode extends ASTNode {
  kind: "StoreDecl";
  name: string;
  engine: string | null;
  schema: FieldNode[];
  retention: string | null;
  partition: string | null;
  replicas: number | null;
}

// â”€â”€â”€ Event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface EventDeclNode extends ASTNode {
  kind: "EventDecl";
  name: string;
  payload: FieldNode[];
  delivery: string | null;
  ttl: string | null;
}

// â”€â”€â”€ Constraint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ConstraintDeclNode extends ASTNode {
  kind: "ConstraintDecl";
  name: string;
  expr: ExprNode;
}

// â”€â”€â”€ Policy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PolicyDeclNode extends ASTNode {
  kind: "PolicyDecl";
  name: string;
  rateLimit: { count: number; per: string } | null;
  access: string[];
  audit: boolean | null;
  encryption: string | null;
  /**
   * Phase 21: zero or more cost-budget declarations. Each budget pairs a
   * scope (per_tenant / per_user / per_feature:<name>) with a sliding window,
   * a cap (USD / tokens / calls), and an on_exceeded action.
   */
  costBudgets: CostBudgetNode[];
}

export interface CostBudgetNode extends ASTNode {
  kind: "CostBudget";
  /** "per_tenant" | "per_user" | "per_feature" — the dimension to bucket on. */
  scope: "per_tenant" | "per_user" | "per_feature";
  /** Required when scope = per_feature. The capability name to gate. */
  feature: string | null;
  /** Window duration string ("1h", "1d", etc.). Lowering converts to ms. */
  window: string;
  /** Exactly one of capUsd / capTokens / capCalls is set. Type checker enforces. */
  capUsd: number | null;
  capTokens: number | null;
  capCalls: number | null;
  /** Action when the cap is reached. "error" or "throttle" in v1. */
  action: "error" | "throttle";
  /** When action=throttle, the Retry-After hint. Required for throttle. */
  retryAfter: string | null;
  /** When action=error, an optional code surfaced in the error response. */
  errorCode: string | null;
}

// â”€â”€â”€ Flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface FlowDeclNode extends ASTNode {
  kind: "FlowDecl";
  name: string;
  steps: FlowStepNode[];
}

export interface FlowStepNode extends ASTNode {
  kind: "FlowStep";
  name: string;
  action: CallExprNode;
  compensate: CallExprNode | null;
  /**
   * Phase 17: optional human-in-the-loop pause primitive. When set, after
   * the step's action completes the flow runner suspends (writes a row to
   * `flow_runs` with state=paused) and waits for an external decision via
   * POST /flow_runs/:id/checkpoint/:name. The decision routes the flow:
   * approve → continue, reject → mark failed, edit → continue with edited
   * payload, regenerate → re-run the step. Timeout falls through to
   * `on_timeout` (`cancel` cancels the run).
   */
  checkpoint: FlowCheckpointNode | null;
}

export interface FlowCheckpointNode extends ASTNode {
  kind: "FlowCheckpoint";
  /** Required label — the URL path segment for resume calls. */
  name: string;
  /** Field paths exposed to the reviewer (e.g. p.plan, p.target_symbol). */
  shows: ExprNode[];
  /** Closed list of allowed decisions. v1 v: approve | reject | edit | regenerate | cancel. */
  allow: string[];
  /** Wait duration as a duration string (e.g. "24h"). Lowering parses to ms. */
  timeout: string | null;
  /** Action when the timeout fires. v1: cancel. */
  onTimeout: "cancel" | null;
}

// â”€â”€â”€ Import â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ImportDeclNode extends ASTNode {
  kind: "ImportDecl";
  name: string;
  from: string;
}

// â”€â”€â”€ Type Expressions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type TypeExprNode =
  | PrimitiveTypeNode
  | GenericTypeNode
  | EntityRefTypeNode
  | TupleTypeNode
  | UnionTypeNode;

export interface PrimitiveTypeNode extends ASTNode {
  kind: "PrimitiveType";
  name: string; // "string" | "uint" | "int" | "float" | "bool" | "timestamp" | "uuid" | "bytes" | "json"
}

export interface GenericTypeNode extends ASTNode {
  kind: "GenericType";
  name: string; // "set" | "list" | "map" | "optional" | "result"
  typeArgs: TypeExprNode[];
}

export interface EntityRefTypeNode extends ASTNode {
  kind: "EntityRefType";
  name: string;
}

export interface TupleTypeNode extends ASTNode {
  kind: "TupleType";
  elements: TypeExprNode[];
}

export interface UnionTypeNode extends ASTNode {
  kind: "UnionType";
  members: TypeExprNode[];
}

// â”€â”€â”€ Expressions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type ExprNode =
  | BinaryExprNode
  | UnaryExprNode
  | FieldRefNode
  | LiteralNode
  | CallExprNode
  | TernaryExprNode;

export interface BinaryExprNode extends ASTNode {
  kind: "BinaryExpr";
  op: string;
  left: ExprNode;
  right: ExprNode;
}

export interface UnaryExprNode extends ASTNode {
  kind: "UnaryExpr";
  op: string;
  operand: ExprNode;
}

export interface FieldRefNode extends ASTNode {
  kind: "FieldRef";
  path: string[]; // e.g., ["player", "inventory", "size"]
}

export interface LiteralNode extends ASTNode {
  kind: "Literal";
  type: "string" | "int" | "float" | "bool" | "none" | "list" | "map";
  value: string | number | boolean | null | ExprNode[] | [ExprNode, ExprNode][];
}

export interface CallExprNode extends ASTNode {
  kind: "CallExpr";
  name: string;
  args: ExprNode[];
}

export interface TernaryExprNode extends ASTNode {
  kind: "TernaryExpr";
  condition: ExprNode;
  consequent: ExprNode;
  alternate: ExprNode;
}

// ─── Extension Point ─────────────────────────────────────────────────────────
// Declares a named hook that the user fills in with custom TypeScript.
// The compiler reserves a region in generated code that survives recompilation.

export interface ExtensionPointDeclNode extends ASTNode {
  kind: "ExtensionPointDecl";
  name: string;
  params: ParamNode[];
  returns: TypeExprNode | null;
  stable: boolean;  // if true, compiler errors if implementation is missing
}

// ─── Cognition Layer (LLM Harness, Phase 1) ──────────────────────────────────
// New top-level decls: model, prompt, router. These give the compiler enough
// information to emit a deterministic LLM harness that calls out to local or
// OpenAI-compatible inference servers through a narrow, typed interface.
// The runtime stays deterministic; the model invocation is the only
// non-deterministic surface, and it is wrapped in retry / validate / cache.

/** Cost class — drives router tier ordering and budget gauges. */
export type CostClass = "tiny" | "small" | "medium" | "large";

/** Latency class — soft hint for routing under SLOs. */
export type LatencyClass = "fast" | "medium" | "slow";

/** Provider name — a closed set; new providers require a new adapter. */
export type ProviderKind =
  | "openai_compat"
  | "ollama"
  | "llamacpp"
  | "koboldcpp"
  | "http";

/** Validate mode — applied to the model's response after parsing. */
export type ValidateMode =
  | { kind: "none" }
  | { kind: "schema_only" }
  | { kind: "ast_compiles" }
  | { kind: "custom"; extensionPoint: string };

/** Recovery action when validation fails. */
export type OnInvalidAction =
  | "fail"
  | "retry"
  | "retry_with_repair_prompt"
  | "escalate";

/** model decl: declares a model adapter and its budget envelope. */
export interface ModelDeclNode extends ASTNode {
  kind: "ModelDecl";
  name: string;
  provider: ProviderKind | null;       // required at type-check; null until parsed
  modelName: string | null;            // the `name:` field (provider-specific)
  endpoint: string | null;             // for openai_compat / http
  contextWindow: number | null;
  maxOutput: number | null;
  temperature: number | null;
  topP: number | null;
  stop: string[] | null;               // list of stop sequences
  costClass: CostClass | null;
  latencyClass: LatencyClass | null;
  vramMb: number | null;
  quant: string | null;
}

/** prompt decl: typed prompt with execution policy. */
export interface PromptDeclNode extends ASTNode {
  kind: "PromptDecl";
  name: string;
  params: ParamNode[];
  returns: TypeExprNode | null;
  modelRef: string | null;             // model name; mutually exclusive with routerRef
  routerRef: string | null;            // router name; mutually exclusive with modelRef
  template: string | null;             // literal string OR "extension_point:NAME"
  validate: ValidateMode;
  onInvalid: OnInvalidAction;
  retry: RetryPolicyNode | null;
  timeout: string | null;
  cache: PromptCacheNode | null;
  idempotent: boolean | null;
  constraints: ExprNode[];             // expressions over output.* and inputs
  allowedTools: string[];              // capability names; empty = no tool use
  /**
   * Phase 18: when set, the prompt's template is sourced from the closed
   * promptbook registry (compiler/src/promptbook.ts). The `with:` clause
   * supplies parameters that get interpolated into the baseline template.
   * Mutually exclusive with `template:`.
   */
  promptbookRef: string | null;
  /** Phase 18: parameter bindings for the promptbook entry. Each is name = literal. */
  promptbookArgs: { name: string; value: ExprNode }[];
  /** Phase 25: yield tokens as they arrive instead of waiting for full response. */
  stream: boolean;
  /** Phase 24: version number for A/B testing / comparison. */
  version: number | null;
  /** Phase 24: shadow version config for parallel A/B testing. */
  shadow: { version: number; traffic: number } | null;
  /** Phase 26: bounded refinement loop config. */
  loop: { steps: string[]; until: string; max_iterations: number } | null;
}

export interface PromptCacheNode {
  kind: "PromptCache";
  keyExpr: ExprNode | null;            // null = default deterministic key
  ttl: string | null;
}

/** router decl: deterministic decision tree over input metric → model. */
export interface RouterDeclNode extends ASTNode {
  kind: "RouterDecl";
  name: string;
  byExpr: ExprNode | null;             // routing key expression (input.complexity, etc.)
  tiers: RouterTierNode[];
  onLowConfidence: "fail" | "escalate" | "retry";
  confidenceThreshold: number | null;
  fallbackModel: string | null;
  /**
   * Phase 19: closed list of metric names the runtime should observe per call.
   * Examples: "validation_pass_rate", "latency_p95_ms", "cost_usd_per_call".
   * The router's runtime decision logic stays static (deterministic at runtime),
   * but `marrowc tune-router <name>` (offline) reads observed metrics to
   * recompute the embedded decision table at compile time.
   */
  observe: string[];
  /**
   * Phase 19: optional policy that constrains which routes the tuner may
   * pick. `minimize_cost_subject_to` accepts a list of comparison expressions
   * (e.g. `validation_pass_rate >= 0.9`). v1 only parses + stores them; the
   * tuner CLI is offline / future work.
   */
  policy: RouterPolicyNode | null;
}

export interface RouterPolicyNode extends ASTNode {
  kind: "RouterPolicy";
  /** "minimize_cost_subject_to" is the only objective in v1. */
  objective: "minimize_cost_subject_to";
  /** Constraint expressions (typically `metric_name >= literal`). */
  constraints: ExprNode[];
}

export interface RouterTierNode extends ASTNode {
  kind: "RouterTier";
  name: string;
  max: number | null;                  // null = default tier (must be last)
  modelRef: string;
}

/** cognition: <name> using { ... } — mirrors AlgorithmNode. */
export interface CognitionNode extends ASTNode {
  kind: "Cognition";
  name: string;                        // catalog entry, e.g. "compress_context"
  using: AlgorithmBinding[];           // typed parameter bindings (reuse algorithm shape)
}

// ─── Evaluation (LLM Harness, Phase 16) ─────────────────────────────────────
//
// An evaluation is a typed regression test for a prompt. Cases bind input
// shapes and expected-output assertions; the runner compares each case's
// output to the expectations and reports per-case pass/fail plus an overall
// metric. Baselines are stored in eval/<name>.baseline.json so a CI pipeline
// can detect regressions ("85% pass rate dropped to 70% — fail the PR").
//
// The evaluation is *not* a runtime callable — it's a static spec. The CLI
// (`marrowc evaluate <name>`) emits a runner that executes cases against
// the live prompt registry.

export interface EvaluationDeclNode extends ASTNode {
  kind: "EvaluationDecl";
  name: string;
  /** Prompt name this evaluation targets. Type checker validates existence. */
  promptRef: string;
  cases: EvaluationCaseNode[];
  /** Optional: aggregate metric. Default is pass_rate. */
  metric: EvaluationMetricNode | null;
  /** Optional: baseline policy ({ min_pass_rate: 0.85, ...}). */
  baseline: EvaluationBaselineNode | null;
  /** Optional: schedule hints ({ on: ["pre_commit", "ci_pr"] }). */
  schedule: EvaluationScheduleNode | null;
}

export interface EvaluationCaseNode extends ASTNode {
  kind: "EvaluationCase";
  caseName: string;
  /** Input bindings — { paramName: <expr> } passed to the prompt. */
  input: EvaluationInputBinding[];
  /** Per-case expectations applied to the parsed output. */
  expectations: EvaluationExpectationNode[];
}

export interface EvaluationInputBinding extends ASTNode {
  kind: "EvaluationInputBinding";
  param: string;
  value: ExprNode;
}

/**
 * One expectation. Each kind corresponds to a built-in operator emitted
 * by the runner. Adding a new operator means: extend this union, parse it,
 * and emit the runtime check in emit_evaluation.ts.
 */
export type EvaluationExpectationNode =
  | { kind: "ExpPasses"; mode: "ast_compiles" | "schema_only"; loc: SourceLocation }
  | { kind: "ExpContainsClassNamed"; pattern: string; loc: SourceLocation }
  | { kind: "ExpMustContainString"; values: string[]; loc: SourceLocation }
  | { kind: "ExpMustNotContainString"; values: string[]; loc: SourceLocation }
  | { kind: "ExpImportsOnlyFrom"; allowed: string[]; loc: SourceLocation }
  | { kind: "ExpMaxLines"; value: number; loc: SourceLocation }
  | { kind: "ExpMinLines"; value: number; loc: SourceLocation }
  | { kind: "ExpLatencyUnderMs"; value: number; loc: SourceLocation };

export interface EvaluationMetricNode extends ASTNode {
  kind: "EvaluationMetric";
  /** Currently only "pass_rate" is supported. Future: "weighted_pass_rate". */
  metric: "pass_rate";
}

export interface EvaluationBaselineNode extends ASTNode {
  kind: "EvaluationBaseline";
  /** Floor for the chosen metric. CI fails if the run falls below this. */
  minPassRate: number;
}

export interface EvaluationScheduleNode extends ASTNode {
  kind: "EvaluationSchedule";
  /** Lifecycle hints: "pre_commit", "ci_pr", "ci_main", etc. */
  on: string[];
}
