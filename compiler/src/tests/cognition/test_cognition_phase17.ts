/**
 * MarrowScript Cognition Phase 17 Tests — flow.checkpoint primitive
 *
 * Verifies:
 *   1. Lexer recognises new tokens: checkpoint, shows, allow, on_timeout,
 *      approve, reject, cancel.
 *   2. Parser produces FlowStepNode.checkpoint with name, shows, allow,
 *      timeout, on_timeout. Compensate-and-checkpoint clauses can appear
 *      in either order.
 *   3. Lowering populates IRFlowStep.checkpoint with serialised shows
 *      expressions and timeout converted to ms.
 *   4. Type checker codes T040–T043:
 *        T040: empty allow list
 *        T041: timeout = 0
 *        T042: duplicate checkpoint name within a flow
 *        T043: unsupported decision string
 *   5. emitCheckpointFiles produces exactly 3 files when at least one flow
 *      declares a checkpoint, and zero otherwise:
 *        migrations/flow_runs.sql
 *        src/flows/checkpoints.ts
 *        src/routes/flow_runs.ts
 *   6. The generated runtime exposes the documented API:
 *      startFlowRun, pauseFlowRun, awaitDecision, submitDecision,
 *      markRunCompleted, markRunFailed, markRunCancelled, markRunResumed,
 *      getFlowRunWithPending, buildShowsPayload.
 *   7. The HTTP route enforces the per-(flow,checkpoint) allow list.
 *   8. Determinism — emitCheckpointFiles is bitwise stable across two runs.
 */

import { Lexer, TokenKind } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";
import { emitCheckpointFiles, checkpointsNeeded } from "../emit_checkpoint";

let passed = 0;
let failed = 0;

function ok(name: string): void { console.log(`  v ${name}`); passed++; }
function fail(name: string, msg: string): void { console.log(`  x ${name}: ${msg}`); failed++; }

function compile(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) {
    throw new Error("type check failed: " + errs.map(e => e.code + ":" + e.message).join("; "));
  }
  return new Lowering().lower(ast, "phase17-test")[0];
}
function tcheck(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  return new TypeChecker().check(ast);
}

console.log("MarrowScript Cognition Phase 17 Tests — flow checkpoint primitive\n");

// ─── Section 1: lexer ───────────────────────────────────────────────────────

console.log("Section 1: Lexer recognises Phase 17 keywords");
{
  const src = "checkpoint shows allow on_timeout approve reject cancel";
  const tokens = new Lexer(src).tokenize();
  const checks: [string, TokenKind][] = [
    ["checkpoint", TokenKind.KwCheckpoint],
    ["shows", TokenKind.KwShows],
    ["allow", TokenKind.KwAllow],
    ["on_timeout", TokenKind.KwOnTimeout],
    ["approve", TokenKind.KwApprove],
    ["reject", TokenKind.KwReject],
    ["cancel", TokenKind.KwCancel],
  ];
  for (const [name, kind] of checks) {
    if (tokens.some(t => t.kind === kind && t.value === name)) ok(`lexer: '${name}' → ${kind}`);
    else fail(`lexer ${name}`, "missing");
  }
}

// ─── Section 2: parsing + lowering ──────────────────────────────────────────

console.log("\nSection 2: Parser + lowering build the IR");

const phase17System = compile(`
  system Phase17 {
    entity Doc { owns: [body: string] }

    capability run_patch(d: Doc) {
      requires: [d.body != ""]
      sync: eventual
      idempotent: true
    }
    capability save_patch(d: Doc) {
      requires: [d.body != ""]
      sync: eventual
      idempotent: true
    }
    capability rollback_patch(d: Doc) {
      requires: [d.body != ""]
      sync: eventual
      idempotent: true
    }

    flow patch_review {
      step generate: run_patch(d)
        checkpoint: review_plan {
          shows: [d.body, d.id]
          allow: ["approve", "edit", "regenerate", "reject"]
          timeout: 24h
          on_timeout: cancel
        }
      step apply: save_patch(d)
        compensate: rollback_patch(d)
    }
  }
`);

{
  const flow = phase17System.flows[0];
  if (flow && flow.steps.length === 2) ok("IR: flow has 2 steps");
  else fail("flow steps", String(flow?.steps?.length));

  const generate = flow.steps[0];
  if (generate.checkpoint !== null) ok("IR: step[0] has checkpoint");
  else fail("checkpoint set", "null");

  const cp = generate.checkpoint;
  if (cp && cp.name === "review_plan") ok("IR: checkpoint name=review_plan");
  else fail("cp name", cp?.name ?? "null");

  if (cp && cp.shows.length === 2) ok("IR: shows[2] preserved");
  else fail("shows count", String(cp?.shows?.length));

  if (cp && cp.allow.length === 4 && cp.allow.includes("approve") && cp.allow.includes("regenerate")) {
    ok("IR: allow=[approve,edit,regenerate,reject]");
  } else {
    fail("allow", JSON.stringify(cp?.allow));
  }

  // 24h = 86_400_000 ms
  if (cp && cp.timeout_ms === 86_400_000) ok("IR: timeout_ms=86400000 (24h)");
  else fail("timeout_ms", String(cp?.timeout_ms));

  if (cp && cp.on_timeout === "cancel") ok("IR: on_timeout=cancel");
  else fail("on_timeout", String(cp?.on_timeout));

  // Step 'apply' has compensate but no checkpoint.
  const apply = flow.steps[1];
  if (apply.checkpoint === null) ok("IR: step[1] no checkpoint");
  else fail("step[1] checkpoint", "should be null");
  if (apply.compensation !== null) ok("IR: step[1] compensation preserved");
  else fail("compensation", "null");
}

// Also verify checkpoint-after-compensate ordering parses.
{
  const sys = compile(`
    system OrderTest {
      entity D { owns: [b: string] }
      capability a(d: D) {
        requires: [d.b != ""]
        sync: eventual
        idempotent: true
      }
      capability rb(d: D) {
        requires: [d.b != ""]
        sync: eventual
        idempotent: true
      }
      capability b(d: D) {
        requires: [d.b != ""]
        sync: eventual
        idempotent: true
      }
      flow f {
        step s1: a(d)
          compensate: rb(d)
          checkpoint: cp1 {
            shows: [d.b]
            allow: ["approve"]
          }
        step s2: b(d)
      }
    }
  `);
  const cp = sys.flows[0].steps[0].checkpoint;
  if (cp && cp.name === "cp1") ok("parser: checkpoint after compensate parses");
  else fail("compensate-then-checkpoint", "missing");
  if (sys.flows[0].steps[0].compensation !== null) ok("parser: compensate retained alongside checkpoint");
  else fail("compensate retained", "null");
}

// ─── Section 3: type checker T040..T043 ────────────────────────────────────

console.log("\nSection 3: TypeChecker — T040..T043 negative cases");

function expectErr(name: string, code: string, source: string): void {
  const errs = tcheck(source);
  if (errs.some(e => e.code === code)) ok(`${code}: ${name}`);
  else fail(name, `expected ${code}, got [${errs.map(e => e.code).join(", ")}]`);
}

expectErr("empty allow list", "T040", `
  system X {
    entity D { owns: [b: string] }
    capability a(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    capability b(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    flow f {
      step s1: a(d) checkpoint: cp { shows: [d.b] allow: [] }
      step s2: b(d)
    }
  }
`);

expectErr("timeout = 0s", "T041", `
  system X {
    entity D { owns: [b: string] }
    capability a(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    capability b(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    flow f {
      step s1: a(d) checkpoint: cp { shows: [d.b] allow: ["approve"] timeout: 0s }
      step s2: b(d)
    }
  }
`);

expectErr("duplicate checkpoint name", "T042", `
  system X {
    entity D { owns: [b: string] }
    capability a(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    capability b(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    capability c(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    flow f {
      step s1: a(d) checkpoint: cp { shows: [d.b] allow: ["approve"] }
      step s2: b(d) checkpoint: cp { shows: [d.b] allow: ["approve"] }
      step s3: c(d)
    }
  }
`);

expectErr("unsupported decision", "T043", `
  system X {
    entity D { owns: [b: string] }
    capability a(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    capability b(d: D) {
      requires: [d.b != ""]
      sync: eventual
      idempotent: true
    }
    flow f {
      step s1: a(d) checkpoint: cp { shows: [d.b] allow: ["yolo"] }
      step s2: b(d)
    }
  }
`);

// ─── Section 4: emitCheckpointFiles file shape ─────────────────────────────

console.log("\nSection 4: emitCheckpointFiles produces 3 files");

{
  if (checkpointsNeeded(phase17System)) ok("checkpointsNeeded: true when checkpoint declared");
  else fail("needed", "expected true");

  const files = emitCheckpointFiles(phase17System);
  const paths = files.map(f => f.path).sort();
  const expected = ["migrations/flow_runs.sql", "src/flows/checkpoints.ts", "src/routes/flow_runs.ts"];
  if (JSON.stringify(paths) === JSON.stringify(expected)) ok("emitCheckpointFiles: exactly 3 files");
  else fail("paths", JSON.stringify(paths));

  const sql = files.find(f => f.path === "migrations/flow_runs.sql")!;
  for (const tbl of ["CREATE TABLE IF NOT EXISTS flow_runs", "CREATE TABLE IF NOT EXISTS flow_run_checkpoints"]) {
    if (sql.content.includes(tbl)) ok(`sql: ${tbl}`);
    else fail(tbl, "missing");
  }
  for (const idx of ["idx_flow_runs_state", "idx_flow_runs_flow", "idx_flow_checkpoints_pending"]) {
    if (sql.content.includes(idx)) ok(`sql: ${idx}`);
    else fail(idx, "missing");
  }

  const runtime = files.find(f => f.path === "src/flows/checkpoints.ts")!;
  for (const fn of [
    "export async function startFlowRun(",
    "export async function pauseFlowRun(",
    "export function awaitDecision(",
    "export async function submitDecision(",
    "export async function markRunCompleted(",
    "export async function markRunFailed(",
    "export async function markRunCancelled(",
    "export async function markRunResumed(",
    "export async function getFlowRunWithPending(",
    "export function buildShowsPayload(",
  ]) {
    if (runtime.content.includes(fn)) ok(`runtime: ${fn.replace("export async function ", "").replace("export function ", "").slice(0, 30)}…`);
    else fail(fn, "missing");
  }
  // State machine + pending registry assertions.
  if (runtime.content.includes(`const __pending: Map<string, PendingDecision>`)) {
    ok("runtime: in-process pending registry");
  } else {
    fail("pending registry", "missing");
  }
  if (runtime.content.includes("counter(\"flow.checkpoint_timeout\"") &&
      runtime.content.includes("counter(\"flow.checkpoint_decided\"")) {
    ok("runtime: counters for timeout + decided");
  } else {
    fail("counters", "missing");
  }

  const route = files.find(f => f.path === "src/routes/flow_runs.ts")!;
  if (route.content.includes(`flowRunsRouter.get("/:id"`) &&
      route.content.includes(`flowRunsRouter.post("/:id/checkpoint/:name"`)) {
    ok("route: GET + POST endpoints");
  } else {
    fail("endpoints", "missing");
  }
  // Allow map embeds the flow:cp key with its allow list.
  if (route.content.includes(`"patch_review:review_plan": ["approve","edit","regenerate","reject"]`)) {
    ok("route: ALLOW map embeds compile-time allow list");
  } else {
    fail("ALLOW map", "missing or wrong shape");
  }
  if (route.content.includes("DECISION_NOT_ALLOWED")) {
    ok("route: rejects decisions outside allow list");
  } else {
    fail("DECISION_NOT_ALLOWED", "missing");
  }
}

// ─── Section 5: zero files when no checkpoints ─────────────────────────────

console.log("\nSection 5: no checkpoints → no files");

{
  const noCp = compile(`
    system NoCP {
      entity D { owns: [b: string] }
      capability a(d: D) {
        requires: [d.b != ""]
        sync: eventual
        idempotent: true
      }
      capability b(d: D) {
        requires: [d.b != ""]
        sync: eventual
        idempotent: true
      }
      flow f {
        step s1: a(d)
        step s2: b(d)
      }
    }
  `);
  if (!checkpointsNeeded(noCp)) ok("checkpointsNeeded: false when no checkpoint declared");
  else fail("needed", "expected false");
  const files = emitCheckpointFiles(noCp);
  if (files.length === 0) ok("emitCheckpointFiles: zero files");
  else fail("files", String(files.length));
}

// ─── Section 6: determinism ─────────────────────────────────────────────────

console.log("\nSection 6: emitCheckpointFiles is deterministic");

{
  const a = emitCheckpointFiles(phase17System).map(f => f.path + ":" + f.content).join("\n");
  const b = emitCheckpointFiles(phase17System).map(f => f.path + ":" + f.content).join("\n");
  if (a === b && a.length > 0) ok("emitCheckpointFiles: bitwise identical across two runs");
  else fail("determinism", "differ");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 17 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
