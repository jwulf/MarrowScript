/**
 * bone ir (Intermediate Representation) Ã¢â‚¬â€ Data structures.
 * Implements spec/07_IR_SPEC.md.
 *
 * This is the canonical internal form: language-agnostic, fully resolved,
 * strongly typed, and deterministically serializable.
 */

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Primitives Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export type IRPrimitive = "string" | "uint" | "int" | "float" | "bool" | "timestamp" | "uuid" | "bytes" | "json";

export interface IRField {
  name: string;
  type: string;       // primitive name or "list<X>", "set<X>", etc.
  nullable: boolean;
  unique: boolean;
  indexed: boolean;
  default_value: string | null;
  renamed_from?: string | null;
  sensitive?: boolean;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Models Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export interface IRIndex {
  fields: string[];
  unique: boolean;
}

export interface IRModelConstraint {
  kind: "unique" | "non_null" | "range" | "enum" | "check";
  target: string;
  params: Record<string, string | number | string[]>;
}

export interface IRModel {
  name: string;
  fields: IRField[];
  primary_key: string;
  indexes: IRIndex[];
  constraints: IRModelConstraint[];
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Methods / Interfaces Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export interface IRPrecondition {
  expression: string;  // serialized constraint expression
  description: string;
}

export interface IREffect {
  target: string;      // field path
  op: "assign" | "add" | "remove";
  value: string;       // serialized expression
}

export interface IRMethod {
  name: string;
  input: IRField[];
  output: string;      // type expression
  preconditions: IRPrecondition[];
  effects: IREffect[];
  emissions: string[]; // event qualified ids
  idempotent: boolean;
  authenticated: boolean;
  timeout_ms: number;
  retry: IRRetryPolicy | null;
  pipeline: IRPipeline | null;
  algorithm: IRAlgorithm | null;
  cognition: IRCognitionBinding | null;
  sync: string | null;
}

export interface IRPipeline {
  parallel: boolean;
  /** A pipeline is a sequence of plain calls and runtime match dispatches. */
  steps: IRPipelineEntry[];
  on_error: IRPipelineErrorHandler | null;
}

/** A pipeline entry — either a plain step or a Phase 11 runtime match. */
export type IRPipelineEntry = IRPipelineStep | IRPipelineMatch;

export interface IRPipelineStep {
  /** Discriminator. The legacy shape didn't carry this, so we add it here */
  /** with an optional flag — emitters fall through to step semantics when */
  /** the field is absent (preserves backwards compatibility for older    */
  /** fixtures that built IR by hand).                                   */
  kind?: "step";
  call_name: string;
  call_args: string[];   // serialized expressions
  bind_as: string | null;
}

/**
 * Phase 11: runtime match dispatch inside a pipeline. Same input → same
 * branch, deterministic. Compiled to an if/else cascade keyed by the
 * serialized expression in `key_expr`. Each case holds a single step
 * (call + optional bindAs); the default arm is optional. If no default
 * is provided and the runtime key matches no case, the pipeline raises
 * a typed PIPELINE_MATCH_UNHANDLED error which trips on_error.
 */
export interface IRPipelineMatch {
  kind: "match";
  /** Serialized expression evaluated once at runtime. */
  key_expr: string;
  /** Cases in declaration order. Cases share the bind_as namespace with */
  /** their parent pipeline; downstream steps can reference the alias the */
  /** matched arm bound. */
  cases: { literal: string; literal_kind: "string" | "number"; arm: IRPipelineStep }[];
  default_arm: IRPipelineStep | null;
}

export interface IRPipelineErrorHandler {
  action: "rollback" | "compensate" | "ignore" | "retry";
  call_name: string | null;
  call_args: string[];
}

export interface IRAlgorithm {
  catalog_name: string;
  bindings: { param: string; value: string }[];
}

// ─── Cognition binding (LLM Harness, Phase 1) ────────────────────────────────
// Mirrors IRAlgorithm. The cognition catalog (compiler/src/cognition_catalog.ts,
// added in Phase 2) is closed; the type checker rejects unknown names.
export interface IRCognitionBinding {
  catalog_name: string;
  bindings: { param: string; value: string }[];
}

export interface IRRetryPolicy {
  max_attempts: number;
  backoff: "fixed" | "linear" | "exponential";
  interval_ms: number;
}

export interface IRInterface {
  name: string;
  methods: IRMethod[];
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Events Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export type IRDeliveryMode = "at_least_once" | "at_most_once" | "exactly_once";
export type IROrderingMode = "fifo" | "causal" | "total" | "unordered";

export interface IREvent {
  id: string;
  name: string;
  payload: IRField[];
  source: string;       // module id
  delivery: IRDeliveryMode;
  ordering: IROrderingMode;
  ttl_ms: number | null;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ State Machines Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export interface IRTransition {
  from: string;
  to: string;
  trigger: string;
  guard: string | null;
}

export interface IRStateMachine {
  entity: string;
  states: string[];
  initial: string;
  transitions: IRTransition[];
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Modules Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export type IRModuleKind =
  | "api_service"
  | "worker_service"
  | "realtime_service"
  | "auth_service"
  | "data_store"
  | "event_bus"
  | "cache"
  | "gateway"
  | "frontend";

export interface IRModule {
  id: string;
  kind: IRModuleKind;
  name: string;
  interfaces: IRInterface[];
  models: IRModel[];
  events: IREvent[];
  state_machines: IRStateMachine[];
  relations: IRRelation[];
  dependencies: string[];
  config: Record<string, string | number | boolean>;
}

export interface IRRelation {
  name: string;
  kind: "has_one" | "has_many" | "belongs_to" | "many_to_many";
  from_entity: string;
  to_entity: string;
  from_table: string;
  to_table: string;
  foreign_key: string;   // column name on the owning side
  junction_table?: string; // only for many_to_many
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Invariants Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export interface IRInvariant {
  id: string;
  expression: string;
  scope: string; // module id or "global"
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Flow (Saga) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export interface IRFlowStep {
  name: string;
  action: string;       // method qualified id
  compensation: string | null;
  /**
   * Phase 17: optional human-in-the-loop pause primitive. When present, the
   * runtime pauses after the step's action and waits for an out-of-band
   * decision via POST /flow_runs/:id/checkpoint/:name.
   */
  checkpoint: IRFlowCheckpoint | null;
}

export interface IRFlowCheckpoint {
  name: string;
  /** Serialized expressions exposed to the reviewer. */
  shows: string[];
  allow: string[];
  /** Pause TTL — null means no timeout. */
  timeout_ms: number | null;
  on_timeout: "cancel" | null;
}

export interface IRFlow {
  name: string;
  steps: IRFlowStep[];
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Root IR Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export interface IRSystem {
  name: string;
  version: string;
  source_hash: string;
  domain: string | null;
  modules: IRModule[];
  events: IREvent[];
  flows: IRFlow[];
  invariants: IRInvariant[];
  resolution: Record<string, string>; // constraint solver output
  extension_points: IRExtensionPoint[];
  models: IRCogModel[];
  prompts: IRPrompt[];
  routers: IRRouter[];
  /**
   * Phase 15: cognition-bearing capabilities referenced from any prompt's
   * allowed_tools. These may not appear in `modules[].interfaces[].methods`
   * (cognition-only capabilities without entity-typed params don't get a
   * lowered HTTP route). Lowering populates this list directly from the
   * AST so the cognition emitter can build the tool dispatch table.
   */
  tool_capabilities: IRToolCapability[];
  /**
   * Phase 16: typed regression tests for prompts. Each evaluation references
   * a single prompt and a list of cases. The cli `marrowc evaluate <name>`
   * runs cases against the live prompt registry; baselines live in
   * eval/<name>.baseline.json so CI can detect regressions.
   */
  evaluations: IREvaluation[];
  /**
   * Phase 21: cost budgets — multi-tenant quota enforcement. Lowered from
   * `policy.cost_budgets[]` clauses across all policies in the system.
   * The runtime emitter uses this list to generate sliding-window counters
   * and the assertWithinBudget helper called from prompt + capability bodies.
   */
  cost_budgets: IRCostBudget[];
}

export interface IRExtensionPoint {
  name: string;
  params: { name: string; type: string }[];
  returns: string | null;
  stable: boolean;
}

// ─── Cognition Layer IR (LLM Harness, Phase 1) ───────────────────────────────
// These are first-class root-level concepts, alongside modules, events, flows.
// Same determinism rules apply: deterministic ordering, no Date.now() / random.

export type IRProviderKind =
  | "openai_compat"
  | "ollama"
  | "llamacpp"
  | "koboldcpp"
  | "http";

export type IRCostClass = "tiny" | "small" | "medium" | "large";
export type IRLatencyClass = "fast" | "medium" | "slow";

/**
 * IR for a `model` declaration.
 *
 * Note the type name is IRCogModel (not IRModel) to avoid collision with
 * IRModel above, which represents a data-store entity model. The cognition
 * layer reuses no machinery from data-store models — they are entirely
 * separate concerns that happen to share an English noun.
 */
export interface IRCogModel {
  id: string;
  name: string;
  provider: IRProviderKind;
  /** Provider-specific model identifier (e.g. "qwen2.5-coder:1.5b"). */
  model_name: string;
  /** Endpoint URL — required for openai_compat / http; null for fixed-URL providers. */
  endpoint: string | null;
  context_window: number;
  max_output: number;
  temperature: number;
  top_p: number | null;
  stop: string[];
  cost_class: IRCostClass;
  latency_class: IRLatencyClass;
  vram_mb: number | null;
  quant: string | null;
}

export type IRValidateMode =
  | { kind: "none" }
  | { kind: "schema_only" }
  | { kind: "ast_compiles" }
  | { kind: "custom"; extension_point: string };

export type IROnInvalidAction =
  | "fail"
  | "retry"
  | "retry_with_repair_prompt"
  | "escalate";

export interface IRPromptCache {
  /** Serialized expression. Empty string = use default deterministic key. */
  key_expr: string;
  ttl_ms: number;
}

export interface IRPrompt {
  id: string;
  name: string;
  input: IRField[];
  /** Serialized type expression of the prompt's structured output. */
  output_type: string;
  /** model_ref XOR router_ref must be set; type checker enforces. */
  model_ref: string | null;
  router_ref: string | null;
  /** Either a literal string OR "extension_point:NAME". */
  template: string;
  validate: IRValidateMode;
  on_invalid: IROnInvalidAction;
  retry: IRRetryPolicy | null;
  timeout_ms: number;
  cache: IRPromptCache | null;
  idempotent: boolean;
  /** Serialized expressions, applied to the parsed output post-validation. */
  constraints: string[];
  /** Capability names this prompt may call. Empty = no tool use. */
  allowed_tools: string[];
  /** Phase 25: streaming mode — yield tokens as they arrive. */
  stream: boolean;
  /** Phase 24: version number for tracking/comparison. */
  version: number | null;
  /** Phase 24: shadow version for A/B testing. */
  shadow: { version: number; traffic: number } | null;
  /** Phase 26: bounded refinement loop config. */
  loop: IRLoopConfig | null;
}

/** Phase 26: loop configuration for iterative refinement. */
export interface IRLoopConfig {
  /** Maximum iterations before returning best-so-far. */
  max_iterations: number;
  /** Validation condition name (e.g. "ast_compiles", "schema_only"). */
  until: string;
  /** Optional: names of sub-prompts in the loop body (for tracing). */
  steps: string[];
}

// ─── Tool capability descriptor (LLM Harness, Phase 15) ──────────────────────
//
// A capability exposed to a prompt's tool-call loop. Lowering populates one
// entry per cognition-bearing capability that's referenced from any prompt's
// `allowed_tools`. This mirrors the source AST shape because cognition-only
// capabilities (no entity-typed parameter) don't otherwise appear in the
// lowered module tree — they have no DB table or HTTP route.
export interface IRToolCapability {
  name: string;
  /** Capability parameters as the model will see them. */
  params: IRField[];
  /** Cognition catalog primitive name (e.g. "compress_context"). */
  cognition_primitive: string;
  /** Bindings from the capability's `using { ... }` clause. */
  bindings: { param: string; value: string }[];
  /** Declared return type expression. */
  return_type: string;
}

export interface IRRouterTier {
  name: string;
  /** Threshold for this tier; null = default tier (must be last). */
  max: number | null;
  model_ref: string;
}

export interface IRRouter {
  id: string;
  name: string;
  /** Serialized routing key expression. */
  by_expr: string;
  tiers: IRRouterTier[];
  on_low_confidence: "fail" | "escalate" | "retry";
  confidence_threshold: number;
  fallback_model_ref: string | null;
  /**
   * Phase 19: closed list of metric names the runtime records per call.
   * The compile-time tuner reads recorded metrics to recompute the tier
   * thresholds; the runtime decision logic stays static.
   */
  observe: string[];
  /**
   * Phase 19: optional policy. v1: only `minimize_cost_subject_to` with a
   * list of serialised constraint expressions.
   */
  policy: IRRouterPolicy | null;
}

export interface IRRouterPolicy {
  objective: "minimize_cost_subject_to";
  /** Serialised constraint expressions. */
  constraints: string[];
}


// ─── Evaluation IR (LLM Harness, Phase 16) ──────────────────────────────────
//
// One IREvaluation per `evaluation` declaration. Lowered shape mirrors the
// AST closely; expressions in case inputs are serialised to strings (same
// convention as IRPrompt.constraints) so the emitter can either embed
// literals directly or surface a typed binding.

export interface IREvaluation {
  id: string;
  name: string;
  prompt_ref: string;
  cases: IREvaluationCase[];
  metric: "pass_rate";
  /** Floor for the metric; CI fails below this. 0 means no floor. */
  min_pass_rate: number;
  /** Schedule hints — used by emit_evaluation to wire CI yaml. */
  schedule_on: string[];
}

export interface IREvaluationCase {
  name: string;
  /** Serialized expressions per input parameter. Literals are JSON-shaped. */
  input: { param: string; value: string }[];
  expectations: IREvaluationExpectation[];
}

export type IREvaluationExpectation =
  | { kind: "passes"; mode: "ast_compiles" | "schema_only" }
  | { kind: "contains_class_named"; pattern: string }
  | { kind: "must_contain_string"; values: string[] }
  | { kind: "must_not_contain_string"; values: string[] }
  | { kind: "imports_only_from"; allowed: string[] }
  | { kind: "max_lines"; value: number }
  | { kind: "min_lines"; value: number }
  | { kind: "latency_under_ms"; value: number };


// ─── Cost Budget IR (LLM Harness, Phase 21) ─────────────────────────────────
//
// Multi-tenant quota record. One per `cost_budgets:[...]` entry in any policy.
// The runtime emitter walks IRSystem.cost_budgets to:
//   - generate sliding-window counter tables in PG
//   - emit the assertWithinBudget(scope, action) gate called by every prompt
//   - wire admin endpoints for inspection + reset

export interface IRCostBudget {
  /** Stable id derived from (policy, scope, window, cap kind) — used as a counter key. */
  id: string;
  /** Source policy name — useful for human-readable error messages. */
  policy: string;
  scope: "per_tenant" | "per_user" | "per_feature";
  /** Required when scope = per_feature. Capability name to gate. */
  feature: string | null;
  window_ms: number;
  /** Exactly one of cap_usd / cap_tokens / cap_calls is non-null. */
  cap_usd: number | null;
  cap_tokens: number | null;
  cap_calls: number | null;
  action: "error" | "throttle";
  /** When action=throttle, ms hint emitted in Retry-After. */
  retry_after_ms: number | null;
  error_code: string | null;
}
