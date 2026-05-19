/**
 * MarrowScript Composition Emitter
 * Generates real implementations for pipeline and algorithm capabilities.
 */

import * as IR from "./ir";
import { lookupAlgorithm } from "./algorithm_catalog";

// â”€â”€â”€ Pipeline Emission (Leap 1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Generate the body of a pipeline-based capability.
 * Sequential pipelines thread results step-to-step with auto-rollback on error.
 * Parallel pipelines run all steps concurrently and collect results.
 *
 * The optional `system` argument lets the emitter recognise prompt names
 * (so a step like `analyze_forge_request(...)` is wrapped in a cognition
 * call) and primitive-typed inputs (so `req.body.<name>` destructuring is
 * generated). Without `system`, the emitter falls back to the legacy
 * behaviour where every step is treated as a locally-scoped function.
 */
export function emitPipelineBody(
  method: IR.IRMethod,
  indent: string = "    ",
  system?: IR.IRSystem,
): string {
  if (!method.pipeline) return "";
  const lines: string[] = [];
  const p = method.pipeline;

  if (p.parallel) {
    return emitParallelPipeline(method, indent, system);
  }

  const ctx = buildPipelineCtx(method, system);

  // Sequential pipeline
  lines.push(`${indent}// Pipeline: ${p.steps.length} step(s), sequential`);
  // ── 1. Destructure primitive params from req.body (so the pipeline can
  //       reference them by bare name like the non-pipeline path does).
  if (ctx.primitiveParams.length > 0) {
    lines.push(`${indent}const { ${ctx.primitiveParams.join(", ")} } = req.body;`);
  }
  // ── 2. Resolve entity params. Two modes are supported:
  //         (a) Reference mode: caller posts `{ <name>_id: "uuid" }` and the
  //             runtime fetches the row from the entity's table.
  //         (b) Inline mode: caller posts the entity body directly (no
  //             `<name>_id` field). Useful for one-shot pipeline invocations
  //             where the frontend doesn't want to first POST the entity
  //             then POST the capability — common for `forge_from_repos`-
  //             style pipelines that take a request shape and return a
  //             result without persisting the input.
  //       Mode (b) only kicks in when the body looks like the entity
  //       (i.e. has at least one of the entity's fields and no _id).
  for (const fetch of ctx.entityFetches) {
    lines.push(`${indent}let ${fetch.paramName}: any;`);
    lines.push(`${indent}if (req.body && req.body.${fetch.paramName}_id) {`);
    lines.push(`${indent}  ${fetch.paramName} = await queryOne(\`SELECT * FROM ${fetch.tableName} WHERE id = $1\`, [req.body.${fetch.paramName}_id]);`);
    lines.push(`${indent}  if (!${fetch.paramName}) {`);
    lines.push(`${indent}    return res.status(404).json({ error: { code: "NOT_FOUND", message: "${fetch.paramName} not found" } });`);
    lines.push(`${indent}  }`);
    lines.push(`${indent}} else if (req.params && req.params.id) {`);
    lines.push(`${indent}  ${fetch.paramName} = await queryOne(\`SELECT * FROM ${fetch.tableName} WHERE id = $1\`, [req.params.id]);`);
    lines.push(`${indent}  if (!${fetch.paramName}) {`);
    lines.push(`${indent}    return res.status(404).json({ error: { code: "NOT_FOUND", message: "${fetch.paramName} not found" } });`);
    lines.push(`${indent}  }`);
    lines.push(`${indent}} else if (req.body && typeof req.body === "object") {`);
    lines.push(`${indent}  // Inline mode: treat the body as the entity itself.`);
    lines.push(`${indent}  ${fetch.paramName} = req.body;`);
    lines.push(`${indent}} else {`);
    lines.push(`${indent}  return res.status(400).json({ error: { code: "MISSING_INPUT", message: "Provide ${fetch.paramName}_id or the ${fetch.paramName} body" } });`);
    lines.push(`${indent}}`);
  }
  // ── 3. Cognition prompt context — only built if any step is a prompt.
  if (ctx.usesCognitionPrompts) {
    lines.push(`${indent}const { randomUUID: __randomUUID } = require("crypto");`);
    lines.push(`${indent}const __cogCtx = { trace_id: __randomUUID() };`);
    lines.push(`${indent}const { getPrompt: __getPrompt } = require("../cognition");`);
  }
  // ── 4. Cognition primitive context — only built if any step is a primitive.
  if (ctx.usesCognitionPrimitives) {
    lines.push(`${indent}const { runCognition: __runCog } = require("../cognition");`);
  }

  lines.push(`${indent}const __pipeline_completed: { step: string; rollback: (() => Promise<void>) | null }[] = [];`);
  lines.push(`${indent}const __pipeline_results: Record<string, unknown> = {};`);
  lines.push(``);
  lines.push(`${indent}try {`);

  const aliasesSeenSoFar = new Set<string>();
  for (const step of p.steps) {
    if (isMatchEntry(step)) {
      // Phase 11: emit a runtime match dispatch as an if/else cascade.
      emitMatchEntry(step, ctx, aliasesSeenSoFar, lines, indent + "  ", method.name);
      continue;
    }
    const callExpr = generateStepCall(step, ctx, aliasesSeenSoFar);
    if (step.bind_as) {
      lines.push(`${indent}  __pipeline_results["${step.bind_as}"] = await ${callExpr};`);
      aliasesSeenSoFar.add(step.bind_as);
    } else {
      lines.push(`${indent}  await ${callExpr};`);
    }
    lines.push(`${indent}  __pipeline_completed.push({ step: "${step.call_name}", rollback: null });`);
    lines.push(`${indent}  counter("pipeline.step_completed", { method: "${method.name}", step: "${step.call_name}" });`);
  }

  // Success: send the pipeline results to the caller. The trace_id is
  // surfaced at the top level so the frontend can poll /cognition_traces
  // for span detail. The `__pipeline_results` map carries every aliased
  // step output (analysis, artifact, repo_a, repo_b, …) so the frontend
  // can render the artifact directly without a follow-up fetch.
  lines.push(`${indent}  res.json({`);
  lines.push(`${indent}    ok: true,`);
  lines.push(`${indent}    action: "${method.name}",`);
  lines.push(`${indent}    trace_id: ${ctx.usesCognitionPrompts ? "__cogCtx.trace_id" : "null"},`);
  lines.push(`${indent}    results: __pipeline_results,`);
  lines.push(`${indent}  });`);
  lines.push(`${indent}} catch (__err: any) {`);

  // Error handler — run compensations, then re-throw so the outer
  // transactional wrapper (if any) rolls back the DB transaction. The
  // outer wrapper's catch sends the 400 JSON response; non-transactional
  // capabilities still get their handler-level catch.
  if (p.on_error) {
    if (p.on_error.action === "rollback") {
      lines.push(`${indent}  // on_error: rollback completed steps in reverse order`);
      lines.push(`${indent}  for (const c of [...__pipeline_completed].reverse()) {`);
      lines.push(`${indent}    if (c.rollback) await c.rollback().catch(() => {});`);
      lines.push(`${indent}  }`);
    } else if (p.on_error.action === "compensate" && p.on_error.call_name) {
      lines.push(`${indent}  // on_error: invoke compensation`);
      const args = p.on_error.call_args.join(", ");
      lines.push(`${indent}  await ${p.on_error.call_name}(${args}).catch(() => {});`);
    } else if (p.on_error.action === "ignore") {
      lines.push(`${indent}  // on_error: ignore — log only`);
    } else if (p.on_error.action === "retry") {
      lines.push(`${indent}  // on_error: retry not yet supported in inline emission`);
    }
  } else {
    // Default: rollback on error
    lines.push(`${indent}  // Default: rollback completed steps in reverse order`);
    lines.push(`${indent}  for (const c of [...__pipeline_completed].reverse()) {`);
    lines.push(`${indent}    if (c.rollback) await c.rollback().catch(() => {});`);
    lines.push(`${indent}  }`);
  }

  lines.push(`${indent}  counter("pipeline.failed", { method: "${method.name}" });`);
  lines.push(`${indent}  logger.error("pipeline_failed", { event: "${method.name}", metadata: { error: __err.message } });`);
  // Re-throw so the outer transactional wrapper can ROLLBACK the SQL tx
  // and emit the 400 response. The outer try/catch around emitPipelineBody
  // is generated by emit_runtime.ts, so we always have a handler upstream.
  lines.push(`${indent}  throw __err;`);
  lines.push(`${indent}}`);

  return lines.join("\n");
}

function emitParallelPipeline(method: IR.IRMethod, indent: string, system?: IR.IRSystem): string {
  if (!method.pipeline) return "";
  const lines: string[] = [];
  const p = method.pipeline;
  const ctx = buildPipelineCtx(method, system);

  lines.push(`${indent}// Pipeline: ${p.steps.length} step(s), parallel`);
  if (ctx.primitiveParams.length > 0) {
    lines.push(`${indent}const { ${ctx.primitiveParams.join(", ")} } = req.body;`);
  }
  // Same dual-mode entity resolution as the sequential path.
  for (const fetch of ctx.entityFetches) {
    lines.push(`${indent}let ${fetch.paramName}: any;`);
    lines.push(`${indent}if (req.body && req.body.${fetch.paramName}_id) {`);
    lines.push(`${indent}  ${fetch.paramName} = await queryOne(\`SELECT * FROM ${fetch.tableName} WHERE id = $1\`, [req.body.${fetch.paramName}_id]);`);
    lines.push(`${indent}  if (!${fetch.paramName}) {`);
    lines.push(`${indent}    return res.status(404).json({ error: { code: "NOT_FOUND", message: "${fetch.paramName} not found" } });`);
    lines.push(`${indent}  }`);
    lines.push(`${indent}} else if (req.params && req.params.id) {`);
    lines.push(`${indent}  ${fetch.paramName} = await queryOne(\`SELECT * FROM ${fetch.tableName} WHERE id = $1\`, [req.params.id]);`);
    lines.push(`${indent}  if (!${fetch.paramName}) {`);
    lines.push(`${indent}    return res.status(404).json({ error: { code: "NOT_FOUND", message: "${fetch.paramName} not found" } });`);
    lines.push(`${indent}  }`);
    lines.push(`${indent}} else if (req.body && typeof req.body === "object") {`);
    lines.push(`${indent}  ${fetch.paramName} = req.body;`);
    lines.push(`${indent}} else {`);
    lines.push(`${indent}  return res.status(400).json({ error: { code: "MISSING_INPUT", message: "Provide ${fetch.paramName}_id or the ${fetch.paramName} body" } });`);
    lines.push(`${indent}}`);
  }
  if (ctx.usesCognitionPrompts) {
    lines.push(`${indent}const { randomUUID: __randomUUID } = require("crypto");`);
    lines.push(`${indent}const __cogCtx = { trace_id: __randomUUID() };`);
    lines.push(`${indent}const { getPrompt: __getPrompt } = require("../cognition");`);
  }
  if (ctx.usesCognitionPrimitives) {
    lines.push(`${indent}const { runCognition: __runCog } = require("../cognition");`);
  }

  lines.push(`${indent}try {`);
  lines.push(`${indent}  const __results = await Promise.all([`);

  const aliasesSeenSoFar = new Set<string>();
  for (const step of p.steps) {
    if (isMatchEntry(step)) {
      throw new Error(
        `parallel pipelines do not support match steps (in capability '${method.name}'). ` +
        `Use a sequential pipeline if you need runtime branching.`
      );
    }
    lines.push(`${indent}    ${generateStepCall(step, ctx, aliasesSeenSoFar)},`);
  }

  lines.push(`${indent}  ]);`);
  lines.push(`${indent}  counter("pipeline.parallel_completed", { method: "${method.name}", count: "${p.steps.length}" });`);
  lines.push(`${indent}  res.json({`);
  lines.push(`${indent}    ok: true,`);
  lines.push(`${indent}    action: "${method.name}",`);
  lines.push(`${indent}    trace_id: ${ctx.usesCognitionPrompts ? "__cogCtx.trace_id" : "null"},`);
  lines.push(`${indent}    results: __results,`);
  lines.push(`${indent}  });`);
  lines.push(`${indent}} catch (__err: any) {`);
  lines.push(`${indent}  logger.error("parallel_pipeline_failed", { event: "${method.name}", metadata: { error: __err.message } });`);
  lines.push(`${indent}  throw __err;`);
  lines.push(`${indent}}`);

  return lines.join("\n");
}

// ─── Phase 11: match-step emission ────────────────────────────────────────

/** Discriminator helper. Match nodes carry `kind: "match"`; plain steps */
/** either carry `kind: "step"` or omit it (legacy, treated as step).   */
function isMatchEntry(entry: IR.IRPipelineEntry): entry is IR.IRPipelineMatch {
  return (entry as { kind?: string }).kind === "match";
}

/**
 * Emit a runtime match dispatch as an if/else cascade. The key expression
 * is evaluated once into a local; each case compares against a literal.
 * If a case binds an alias, it lands in __pipeline_results just like a
 * regular step would. Cases share the alias namespace with their
 * surrounding pipeline so downstream steps can reference whichever arm
 * fired.
 *
 * Determinism: same key value → same case match. The cascade is rendered
 * in declaration order, so two pipelines lowered from the same .marrow
 * always produce byte-identical output.
 */
function emitMatchEntry(
  match: IR.IRPipelineMatch,
  ctx: PipelineEmitCtx,
  aliasesSeenSoFar: Set<string>,
  lines: string[],
  indent: string,
  methodName: string,
): void {
  // Collect every alias any case binds — they all become reachable in the
  // outer scope after the match completes (because the runtime always runs
  // exactly one arm). We need to add them to aliasesSeenSoFar BEFORE we
  // emit later steps, so dotted-path references resolve correctly.
  const armBoundAliases: string[] = [];
  for (const c of match.cases) {
    if (c.arm.bind_as) armBoundAliases.push(c.arm.bind_as);
  }
  if (match.default_arm?.bind_as) armBoundAliases.push(match.default_arm.bind_as);

  // Rewrite the key expression. The same alias-rewrite + own-input pass
  // we use for arg expressions: lets the user write `r.preset` and it
  // resolves to the route-handler-local `r`.
  const keyJs = rewriteArg(match.key_expr, aliasesSeenSoFar, ctx.ownInputs);

  lines.push(`${indent}// Phase 11: match dispatch on ${match.key_expr}`);
  lines.push(`${indent}{`);
  lines.push(`${indent}  const __match_key = ${keyJs};`);

  for (let i = 0; i < match.cases.length; i++) {
    const c = match.cases[i];
    const cmp =
      c.literal_kind === "string"
        ? `__match_key === ${JSON.stringify(c.literal)}`
        : `Number(__match_key) === ${c.literal}`;
    const guard = i === 0 ? "if" : "else if";
    lines.push(`${indent}  ${guard} (${cmp}) {`);
    emitArm(c.arm, ctx, aliasesSeenSoFar, lines, indent + "  ", methodName);
    lines.push(`${indent}  }`);
  }
  if (match.default_arm) {
    lines.push(`${indent}  else {`);
    emitArm(match.default_arm, ctx, aliasesSeenSoFar, lines, indent + "  ", methodName);
    lines.push(`${indent}  }`);
  } else {
    // No default → throw so the surrounding catch trips on_error.
    lines.push(`${indent}  else {`);
    lines.push(`${indent}    throw new Error("PIPELINE_MATCH_UNHANDLED: no case matched key " + JSON.stringify(__match_key));`);
    lines.push(`${indent}  }`);
  }
  lines.push(`${indent}}`);

  // Make the bound aliases visible to later steps (and to themselves —
  // dotted-path access on the alias works the same as for plain steps).
  for (const a of armBoundAliases) aliasesSeenSoFar.add(a);
}

/** Emit a single match arm body. Same rendering as the plain step path. */
function emitArm(
  step: IR.IRPipelineStep,
  ctx: PipelineEmitCtx,
  aliasesSeenSoFar: Set<string>,
  lines: string[],
  indent: string,
  methodName: string,
): void {
  const callExpr = generateStepCall(step, ctx, aliasesSeenSoFar);
  if (step.bind_as) {
    lines.push(`${indent}__pipeline_results["${step.bind_as}"] = await ${callExpr};`);
  } else {
    lines.push(`${indent}await ${callExpr};`);
  }
  lines.push(`${indent}__pipeline_completed.push({ step: "${step.call_name}", rollback: null });`);
  lines.push(`${indent}counter("pipeline.step_completed", { method: "${methodName}", step: "${step.call_name}" });`);
}

// ─── Pipeline emit context ────────────────────────────────────────────────

interface PipelineEmitCtx {
  method: IR.IRMethod;
  /** Prompts the system has declared, indexed by name so we can map step
   *  args to their declared parameter names (so prompt-side cache:key
   *  expressions resolve and field-named templates render correctly). */
  promptByName: Map<string, IR.IRPrompt>;
  /** Names of cognition-modified capabilities, dispatched via runCognition. */
  cognitionCapabilityNames: Map<string, string>;
  /** Capability methods we know are not pipelines/algorithms — used to map
   *  positional pipeline args to the called capability's parameter names so
   *  the existing route handler can destructure them from req.body. */
  capabilityMethodsByName: Map<string, IR.IRMethod>;
  /** Primitive-typed parameter names of the pipeline-owning method. */
  primitiveParams: string[];
  /** Entity-typed parameter names + their table name (for SELECT). */
  entityFetches: { paramName: string; tableName: string }[];
  /** True if any step is a prompt — drives the __cogCtx prelude. */
  usesCognitionPrompts: boolean;
  /** True if any step is a cognition-modified capability. */
  usesCognitionPrimitives: boolean;
  /** All input parameter names of the owning method (for arg disambiguation). */
  ownInputs: Set<string>;
}

function buildPipelineCtx(method: IR.IRMethod, system?: IR.IRSystem): PipelineEmitCtx {
  const promptByName = new Map<string, IR.IRPrompt>();
  const cognitionCapabilityNames = new Map<string, string>();
  const capabilityMethodsByName = new Map<string, IR.IRMethod>();
  if (system) {
    for (const p of system.prompts) promptByName.set(p.name, p);
    for (const mod of system.modules) {
      for (const iface of mod.interfaces) {
        for (const m of iface.methods) {
          capabilityMethodsByName.set(m.name, m);
          if (m.cognition) cognitionCapabilityNames.set(m.name, m.cognition.catalog_name);
        }
      }
    }
  }

  const PRIMITIVE_TYPES = new Set(["string", "uint", "int", "float", "bool", "timestamp", "uuid", "bytes", "json"]);
  const primitiveParams: string[] = [];
  const entityFetches: { paramName: string; tableName: string }[] = [];
  for (const inp of method.input) {
    if (PRIMITIVE_TYPES.has(inp.type)) {
      primitiveParams.push(inp.name);
    } else {
      // Treat anything non-primitive as an entity reference. The table name
      // mirrors emit_capability.ts:tableNameFromEntity — snake_case + 's'.
      const table = entityTypeToTable(inp.type);
      entityFetches.push({ paramName: inp.name, tableName: table });
    }
  }

  const ownInputs = new Set(method.input.map(i => i.name));

  let usesCognitionPrompts = false;
  let usesCognitionPrimitives = false;
  // Walk every step AND every match-arm so the prelude (cognition ctx,
  // require-imports) gets emitted whenever a prompt or primitive is reachable.
  const collectFromStep = (s: IR.IRPipelineStep): void => {
    if (promptByName.has(s.call_name)) usesCognitionPrompts = true;
    if (cognitionCapabilityNames.has(s.call_name)) usesCognitionPrimitives = true;
  };
  for (const entry of method.pipeline?.steps ?? []) {
    if ((entry as { kind?: string }).kind === "match") {
      const m = entry as IR.IRPipelineMatch;
      for (const c of m.cases) collectFromStep(c.arm);
      if (m.default_arm) collectFromStep(m.default_arm);
    } else {
      collectFromStep(entry as IR.IRPipelineStep);
    }
  }

  return {
    method,
    promptByName,
    cognitionCapabilityNames,
    capabilityMethodsByName,
    primitiveParams,
    entityFetches,
    usesCognitionPrompts,
    usesCognitionPrimitives,
    ownInputs,
  };
}

function entityTypeToTable(type: string): string {
  // EntityName → entity_names. Mirror of emit_capability's pluraliser.
  const snake = type.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return snake.endsWith("s") ? snake : snake + "s";
}

function generateStepCall(
  step: IR.IRPipelineStep,
  ctx: PipelineEmitCtx,
  aliasesSeenSoFar: Set<string>,
): string {
  // Rewrite arg names that reference an earlier `as <alias>` binding so they
  // resolve to the pipeline result map. Bare identifiers that match the
  // owning method's input list pass through unchanged (they're either
  // pre-loaded entities or destructured primitives). Anything else (literals,
  // dotted property access on inputs) also passes through.
  const args = step.call_args.map(arg => rewriteArg(arg, aliasesSeenSoFar, ctx.ownInputs));

  // Prompt step → call via getPrompt with a typed input bag built from the
  // prompt's declared parameter names so the prompt body's cache:key
  // expressions and templates resolve correctly.
  if (ctx.promptByName.has(step.call_name)) {
    const prompt = ctx.promptByName.get(step.call_name)!;
    const inputBag = buildNamedInputBag(args, prompt.input.map(f => f.name));
    return `__getPrompt("${step.call_name}")({ ${inputBag} }, __cogCtx)`;
  }

  // Cognition-modified capability → dispatch through runCognition. We
  // resolve the capability's `using { ... }` bindings inline against the
  // route handler's scope (where `r`, `t`, `auth`, etc. are bound). The
  // catalog primitive sees the named inputs the catalog spec declares, so
  // semantic_slice receives `{ task, max_files, hop_depth }` regardless of
  // how the capability declared its parameters.
  if (ctx.cognitionCapabilityNames.has(step.call_name)) {
    const catalogName = ctx.cognitionCapabilityNames.get(step.call_name)!;
    const m = ctx.capabilityMethodsByName.get(step.call_name);
    const bindings = m?.cognition?.bindings ?? [];
    // Each binding's `value` is a serialized expression from lowering.ts:
    // a dotted path like `r.description`, a literal like `8`, or a string.
    // We pass the value through the same arg-rewrite path so alias references
    // and positional-arg references are handled uniformly. ownInputs covers
    // bare entity names like `r` (which will already be DB-loaded by the
    // pipeline prelude).
    const pairs = bindings.map(b => {
      const expr = rewriteArg(b.value, aliasesSeenSoFar, ctx.ownInputs);
      return `${b.param}: ${expr}`;
    });
    return `__runCog("${catalogName}", { ${pairs.join(", ")} })`;
  }

  // Default — call a locally-scoped capability function. The route handler
  // for the called capability destructures `req.body` itself, so the only
  // way we can pass values into it from a pipeline step is to compose
  // a request-shaped object. To stay backwards-compatible with the existing
  // test fixtures (which use bare-name capability calls), we keep the
  // bare-name dispatch and rely on the called capability already being in
  // scope as a function.
  return `${step.call_name}(${args.join(", ")})`;
}

/** Pair positional args with declared parameter names. Falls back to
 *  `arg<i>` for any extras the IR didn't surface. */
function buildNamedInputBag(args: string[], paramNames: string[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const name = i < paramNames.length ? paramNames[i] : `arg${i}`;
    pairs.push(`${name}: ${args[i]}`);
  }
  return pairs.join(", ");
}

/**
 * Rewrite a single arg expression. Examples:
 *   "analysis"        → __pipeline_results["analysis"] (when it's an alias)
 *   "r.title"         → r.title (passes through; r is in scope from prelude)
 *   "256"             → 256 (literal)
 *   "complexity"      → complexity (own primitive input, destructured)
 *
 * The rewrite is deliberately conservative: we only touch bare identifiers
 * (and bare-identifier-prefixed dotted paths) that match a known alias.
 */
function rewriteArg(arg: string, aliasesSeenSoFar: Set<string>, ownInputs: Set<string>): string {
  const trimmed = arg.trim();
  if (trimmed === "") return arg;
  // String / numeric literals — leave as-is.
  if (/^["'`]/.test(trimmed)) return arg;
  if (/^[0-9]/.test(trimmed)) return arg;
  // boolean / null literals
  if (trimmed === "true" || trimmed === "false" || trimmed === "null" || trimmed === "undefined") return arg;

  // Bare identifier: alias rewrite or pass-through.
  const bareIdent = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (bareIdent) {
    const id = bareIdent[1];
    if (aliasesSeenSoFar.has(id)) return `(__pipeline_results["${id}"] as any)`;
    return id;
  }

  // Dotted path: <head>.<rest>. Rewrite head if it's an alias.
  const dotted = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(.+)$/);
  if (dotted) {
    const head = dotted[1];
    const rest = dotted[2];
    if (aliasesSeenSoFar.has(head)) {
      return `((__pipeline_results["${head}"] as any).${rest})`;
    }
    if (ownInputs.has(head)) return arg;
    return arg;
  }

  // Anything else — pass through unchanged.
  return arg;
}

// â”€â”€â”€ Algorithm Emission (Leap 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Generate the body of an algorithm-based capability by looking up the
 * implementation in the algorithm catalog.
 */
export function emitAlgorithmBody(method: IR.IRMethod, indent: string = "    "): string {
  if (!method.algorithm) return "";

  const spec = lookupAlgorithm(method.algorithm.catalog_name);
  if (!spec) {
    return `${indent}return { ok: false, error: { code: "UNKNOWN_ALGORITHM", message: "Algorithm '${method.algorithm.catalog_name}' not in catalog" } } as any;`;
  }

  const lines: string[] = [];
  lines.push(`${indent}// Algorithm: ${spec.name} (${spec.complexity})`);
  lines.push(`${indent}// ${spec.description}`);
  lines.push(``);
  lines.push(`${indent}try {`);

  // Bind named arguments to algorithm parameters
  const argNames: string[] = [];
  for (const input of spec.inputs) {
    const binding = method.algorithm.bindings.find(b => b.param === input.name);
    if (binding) {
      argNames.push(binding.value);
    } else {
      argNames.push(input.name); // assume it's a method parameter
    }
  }

  const fnName = camelize(spec.name);
  lines.push(`${indent}  const __result = ${fnName}(${argNames.join(", ")});`);
  lines.push(`${indent}  counter("algorithm.invoked", { algorithm: "${spec.name}" });`);
  lines.push(`${indent}  return { ok: true, value: __result } as any;`);
  lines.push(`${indent}} catch (__err: any) {`);
  lines.push(`${indent}  logger.error("algorithm_failed", { event: "${spec.name}", metadata: { error: __err.message } });`);
  lines.push(`${indent}  return { ok: false, error: { code: "ALGORITHM_FAILED", message: __err.message } } as any;`);
  lines.push(`${indent}}`);

  return lines.join("\n");
}

function camelize(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// â”€â”€â”€ Algorithms File Emission â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Emit a single TypeScript file containing all algorithm implementations
 * referenced by capabilities in the system.
 */
export function emitAlgorithmsFile(usedAlgorithms: Set<string>): string {
  if (usedAlgorithms.size === 0) return "";

  const lines: string[] = [];
  lines.push(`// Generated by MarrowScript compiler. DO NOT EDIT.`);
  lines.push(`// Algorithm implementations from MarrowScript catalog.`);
  lines.push(``);

  for (const name of [...usedAlgorithms].sort()) {
    const spec = lookupAlgorithm(name);
    if (!spec) continue;
    lines.push(`// â”€â”€â”€ ${spec.name} (${spec.category}, ${spec.complexity}) â”€â”€â”€â”€â”€`);
    lines.push(`// ${spec.description}`);
    lines.push(`export ${spec.emit({}).trim()}`);
    lines.push(``);
  }

  return lines.join("\n");
}

// â”€â”€â”€ Collect Used Algorithms â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function collectUsedAlgorithms(system: IR.IRSystem): Set<string> {
  const used = new Set<string>();
  for (const mod of system.modules) {
    for (const iface of mod.interfaces) {
      for (const method of iface.methods) {
        if (method.algorithm) used.add(method.algorithm.catalog_name);
      }
    }
  }
  return used;
}
