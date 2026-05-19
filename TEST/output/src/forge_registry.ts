/**
 * In-memory forge run registry.
 *
 * The synchronous `/repo_forge_requests/forge-from-repos` route works fine
 * for one-round-trip callers. But a frontend that may refresh mid-flight
 * needs an async pattern: start the forge, get an id, poll. This module
 * provides that. Runs are stored in a Map keyed by uuid; the registry
 * survives across HTTP requests for the lifetime of the Node process.
 *
 * Production deployments would back this with Postgres + a job queue. For
 * dev, in-memory is fine — refreshes within a single backend process do
 * recover correctly. If the backend itself restarts mid-flight, the run
 * is lost (which is the same behaviour as the sync path).
 *
 * Memory hygiene: completed runs are kept for 1 hour after finish so the
 * UI has time to fetch the result; after that they're swept on the next
 * registry mutation. Failed runs follow the same TTL.
 */

import { randomUUID } from "crypto";
import type { CognitionSpan } from "./cognition/traces";

export type ForgeRunStatus = "running" | "done" | "error" | "cancelled";

export interface ForgeRunStep {
  name: string;
  state: "pending" | "running" | "done" | "error";
  started_at?: number;
  finished_at?: number;
  meta?: string;
}

export interface ForgeRunRecord {
  id: string;
  status: ForgeRunStatus;
  started_at: number;
  finished_at: number | null;
  /** Echoed back to the UI so a refresh shows the user what was being forged. */
  request: Record<string, unknown>;
  /** trace_id from the cognition runtime — links the run to /cognition_traces. */
  trace_id: string | null;
  /** Per-step progress. The UI uses this to drive its stepper. */
  steps: ForgeRunStep[];
  /** Populated when status transitions to "done". */
  result: {
    repo_a?: unknown;
    repo_b?: unknown;
    analysis?: string;
    scoped?: string;
    artifact?: string;
  } | null;
  /** Populated when status transitions to "error". */
  error: string | null;
  /** Spans observed during the run, kept for the trace tab even if the
   *  cognition_traces store rolls them out. */
  spans?: CognitionSpan[];
  /** AbortController so the run can be cancelled by the user. */
  abort: AbortController;
}

const RUNS = new Map<string, ForgeRunRecord>();
const TTL_AFTER_FINISH_MS = 60 * 60 * 1000; // keep finished runs visible for 1h

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, run] of RUNS.entries()) {
    if (run.status !== "running" && run.finished_at && now - run.finished_at > TTL_AFTER_FINISH_MS) {
      RUNS.delete(id);
    }
  }
}

export function createRun(request: Record<string, unknown>, initialSteps: ForgeRunStep[]): ForgeRunRecord {
  sweepExpired();
  const record: ForgeRunRecord = {
    id: randomUUID(),
    status: "running",
    started_at: Date.now(),
    finished_at: null,
    request,
    trace_id: null,
    steps: initialSteps,
    result: null,
    error: null,
    abort: new AbortController(),
  };
  RUNS.set(record.id, record);
  return record;
}

export function getRun(id: string): ForgeRunRecord | null {
  return RUNS.get(id) ?? null;
}

export function setStepState(id: string, name: string, state: ForgeRunStep["state"], meta?: string): void {
  const run = RUNS.get(id);
  if (!run) return;
  const step = run.steps.find((s) => s.name === name);
  if (!step) return;
  if (state === "running" && !step.started_at) step.started_at = Date.now();
  if ((state === "done" || state === "error") && !step.finished_at) step.finished_at = Date.now();
  step.state = state;
  if (meta !== undefined) step.meta = meta;
}

export function setRunResult(id: string, result: ForgeRunRecord["result"], traceId: string | null): void {
  const run = RUNS.get(id);
  if (!run) return;
  run.result = result;
  run.trace_id = traceId;
  run.status = "done";
  run.finished_at = Date.now();
  for (const s of run.steps) if (s.state !== "done" && s.state !== "error") s.state = "done";
}

export function setRunError(id: string, error: string): void {
  const run = RUNS.get(id);
  if (!run) return;
  run.error = error;
  run.status = "error";
  run.finished_at = Date.now();
}

export function cancelRun(id: string): boolean {
  const run = RUNS.get(id);
  if (!run) return false;
  if (run.status !== "running") return false;
  run.abort.abort();
  run.status = "cancelled";
  run.error = "cancelled by user";
  run.finished_at = Date.now();
  return true;
}

/** Snapshot for serialization to the UI. The AbortController + spans are stripped. */
export function snapshot(run: ForgeRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    request: run.request,
    trace_id: run.trace_id,
    steps: run.steps,
    result: run.result,
    error: run.error,
  };
}
