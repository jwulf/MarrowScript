/**
 * Async forge runs — the resilient frontend path.
 *
 * Routes:
 *   POST   /forge_runs/start    register a forge, kick it off in the
 *                               background, return { forge_id } immediately
 *   GET    /forge_runs/:id      current status: running / done / error /
 *                               cancelled, plus per-step progress and
 *                               (when ready) the full result
 *   DELETE /forge_runs/:id      cancel a running forge
 *
 * Why this exists alongside the sync /repo_forge_requests/forge-from-repos:
 *   The sync route works fine for callers that hold one long-lived HTTP
 *   request open. But a frontend that might refresh mid-flight needs to
 *   re-attach to the running forge after reload — there's no way to do
 *   that with a single round-trip. This async pattern persists the run on
 *   the server, hands the UI an id, and lets the UI poll for progress.
 */

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth, AuthContext } from "../auth";
import { logger } from "../logger";
import { counter } from "../metrics";
import {
  createRun,
  getRun,
  cancelRun,
  setStepState,
  setRunResult,
  setRunError,
  snapshot,
  type ForgeRunStep,
} from "../forge_registry";

export const forgeRunsRouter = Router();

const __routeRateLimit = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });

// ── POST /forge_runs/start ─────────────────────────────────────────────────

forgeRunsRouter.post("/start", __routeRateLimit, requireAuth, async (req: Request, res: Response) => {
  const auth: AuthContext = (req as any).auth;
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: { code: "MISSING_BODY", message: "Body must be a RepoForgeRequest" } });
  }

  const initialSteps: ForgeRunStep[] = [
    { name: "ingest_repo_a",                state: "pending" },
    { name: "ingest_repo_b",                state: "pending" },
    { name: "analyze_repo_forge_request",   state: "pending" },
    { name: "scope_for_typescript",         state: "pending" },
    { name: "generate_forge_artifact",      state: "pending" },
  ];
  const run = createRun(body, initialSteps);

  // Send the id back immediately so the UI can persist it and poll.
  res.json({ forge_id: run.id });

  // Run the pipeline in the background. We do NOT await this — it runs after
  // the response has been sent. Errors are caught and recorded on the run
  // record; nothing throws back to the response.
  void executeForge(run.id, body, auth.trace_id).catch((err: Error) => {
    logger.error("forge_run_unhandled", { event: "forge_runs", status: "failure", trace_id: auth.trace_id, metadata: { error: err.message.slice(0, 256), forge_id: run.id } });
    setRunError(run.id, err.message);
  });
});

// ── GET /forge_runs/:id ────────────────────────────────────────────────────

forgeRunsRouter.get("/:id", __routeRateLimit, requireAuth, async (req: Request, res: Response) => {
  const run = getRun(req.params.id);
  if (!run) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Forge run not found or expired" } });
  }
  res.json(snapshot(run));
});

// ── DELETE /forge_runs/:id ─────────────────────────────────────────────────

forgeRunsRouter.delete("/:id", __routeRateLimit, requireAuth, async (req: Request, res: Response) => {
  const cancelled = cancelRun(req.params.id);
  if (!cancelled) {
    return res.status(404).json({ error: { code: "NOT_FOUND_OR_DONE", message: "Run not found or already finished" } });
  }
  res.json({ ok: true, action: "cancelled" });
});

// ── Background executor ────────────────────────────────────────────────────

async function executeForge(forgeId: string, body: Record<string, unknown>, traceId: string): Promise<void> {
  const cognition = require("../cognition") as {
    runCognition: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    getPrompt: (name: string) => (input: Record<string, unknown>, ctx: { trace_id: string; signal?: AbortSignal }) => Promise<unknown>;
  };
  const run = getRun(forgeId);
  if (!run) return;
  const cogCtx = { trace_id: traceId, signal: run.abort.signal };
  run.trace_id = traceId;

  try {
    counter("forge_runs.started", { forge_id: forgeId });

    // Step 1: ingest repo A
    setStepState(forgeId, "ingest_repo_a", "running");
    const repoA = await cognition.runCognition("ingest_repository", {
      url: body.repo_a_url,
      ref: body.repo_a_ref,
    }) as { url_redacted: string; head_sha: string; file_count: number; total_bytes: number; cached: boolean };
    setStepState(forgeId, "ingest_repo_a", "done", `${repoA.file_count} files`);

    if (run.abort.signal.aborted) throw new Error("cancelled");

    // Step 2: ingest repo B
    setStepState(forgeId, "ingest_repo_b", "running");
    const repoB = await cognition.runCognition("ingest_repository", {
      url: body.repo_b_url,
      ref: body.repo_b_ref,
    }) as { url_redacted: string; head_sha: string; file_count: number; total_bytes: number; cached: boolean };
    setStepState(forgeId, "ingest_repo_b", "done", `${repoB.file_count} files`);

    if (run.abort.signal.aborted) throw new Error("cancelled");

    // Step 3: analyze
    setStepState(forgeId, "analyze_repo_forge_request", "running");
    const analysis = await cognition.getPrompt("analyze_repo_forge_request")({
      title: body.title,
      description: body.description,
      preset: body.preset,
      repo_a_url: body.repo_a_url,
      repo_a_files: repoA.file_count,
      repo_a_sha: repoA.head_sha,
      repo_b_url: body.repo_b_url,
      repo_b_files: repoB.file_count,
      repo_b_sha: repoB.head_sha,
    }, cogCtx) as string;
    setStepState(forgeId, "analyze_repo_forge_request", "done");

    if (run.abort.signal.aborted) throw new Error("cancelled");

    const preset = String(body.preset);
    const isReport = preset === "compare_apis" || preset === "migrate";

    // Step 4: scope (codegen presets only)
    let planForGen: string = analysis;
    if (!isReport) {
      setStepState(forgeId, "scope_for_typescript", "running");
      planForGen = await cognition.getPrompt("scope_for_typescript")({
        description: body.description,
        preset: body.preset,
        analysis,
      }, cogCtx) as string;
      setStepState(forgeId, "scope_for_typescript", "done");
    } else {
      // Skip scope step for report presets — mark it complete immediately.
      setStepState(forgeId, "scope_for_typescript", "done", "skipped (report preset)");
    }

    if (run.abort.signal.aborted) throw new Error("cancelled");

    // Step 5: generate
    setStepState(forgeId, "generate_forge_artifact", "running");
    const generatorName = isReport ? "generate_forge_report" : "generate_forge_artifact";
    const artifact = await cognition.getPrompt(generatorName)({
      plan: planForGen,
      target_symbol: "",
      files: "",
      desired_kind: body.preset,
      target_path: body.target_path,
      description: body.description,
      complexity: body.complexity,
    }, cogCtx) as string;
    const elapsed = Math.round(Date.now() - run.started_at);
    setStepState(forgeId, "generate_forge_artifact", "done", `${elapsed.toLocaleString()}ms total`);

    setRunResult(forgeId, {
      repo_a: repoA,
      repo_b: repoB,
      analysis,
      scoped: !isReport ? planForGen : undefined,
      artifact,
    }, traceId);

    counter("forge_runs.succeeded", { forge_id: forgeId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Mark the currently-running step as errored so the UI sees where it failed.
    const current = run.steps.find((s) => s.state === "running");
    if (current) setStepState(forgeId, current.name, "error", msg.slice(0, 200));
    setRunError(forgeId, msg);
    counter("forge_runs.failed", { forge_id: forgeId });
  }
}
