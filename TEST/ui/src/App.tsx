import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { ForgeResponse, ForgeRunSnapshot, RepoForgeRequest } from "./api";
import { cancelForgeRun, getCognitionTrace, getForgeRun, getToken, startForgeRun } from "./api";
import { TokenBar } from "./components/TokenBar";
import { ConnectionPill } from "./components/ConnectionPill";
import { RequestPanel } from "./components/RequestPanel";
import { PipelineProgress, type StepStatus } from "./components/PipelineProgress";
import { ResultPanel } from "./components/ResultPanel";
import { HistorySidebar } from "./components/HistorySidebar";
import { ConstitutionPanel } from "./components/ConstitutionPanel";
import { InspectorPanel } from "./components/InspectorPanel";
import {
  addToHistory, loadHistory, removeFromHistory, saveHistory,
  type HistoryEntry,
} from "./history";
import {
  applyConstitutionToDescription, loadConstitution, saveConstitution,
  type Constitution,
} from "./constitution";

const DEFAULT_REQUEST: RepoForgeRequest = {
  title: "Compare two reference repos",
  description:
    "Compare these two repos. Identify functional overlap, differences in surface area, and produce a concise markdown report a human can read in two minutes.",
  preset: "compare_apis",
  repo_a_url: "https://github.com/octocat/Hello-World",
  repo_a_ref: "HEAD",
  repo_b_url: "https://github.com/octocat/Spoon-Knife",
  repo_b_ref: "HEAD",
  target_path: "REPORT.md",
  complexity: 0.4,
};

const STORAGE_REQUEST = "marrowforge_last_request";
const STORAGE_RESULT  = "marrowforge_last_result";
const STORAGE_FORGE_ID = "marrowforge_active_forge_id";
// Result entries get pruned automatically — we don't want to keep showing a
// week-old artifact if the user opens the app fresh. 24h matches the JWT
// lifetime so once the token expires the cached result also rolls off.
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
// Polling cadence for in-flight forges. 1.5s is a reasonable trade between
// responsive progress display and not hammering the backend.
const POLL_INTERVAL_MS = 1500;

interface PersistedResult {
  result: ForgeResponse;
  request: RepoForgeRequest;
  saved_at: number;
}

// Top-level state machine. Three view states; transitions driven by the
// async forge call. We persist running state too — `phase: "running"` plus
// the active `forge_id` go to localStorage so a refresh resumes the UI.
type Phase = "idle" | "running" | "done" | "error";

// Pipeline shape derivation. Mirrors the backend's `forge_from_repos`
// pipeline exactly: ingest A → ingest B → analyze → scope → generate.
function derivePipelineSteps(preset: RepoForgeRequest["preset"]): StepStatus[] {
  const isReport = preset === "compare_apis" || (preset as string) === "migrate";
  const generator = isReport ? "generate_forge_report" : "generate_forge_artifact";
  const generatorDesc = isReport
    ? "Markdown report (validate: schema_only)"
    : "TypeScript artifact (validate: ast_compiles, repair on failure)";
  const baseSteps: StepStatus[] = [
    { name: "ingest_repo_a",                description: "Clone repo A — sandboxed, deny-list aware, size-capped", state: "pending" as const },
    { name: "ingest_repo_b",                description: "Clone repo B",                                           state: "pending" as const },
    { name: "analyze_repo_forge_request",   description: "Tiny model produces a typed plan + ingredient hints",     state: "pending" as const },
  ];
  if (!isReport) {
    baseSteps.push({
      name: "scope_for_typescript",
      description: "Translate the plan into something achievable in TypeScript",
      state: "pending" as const,
    });
  }
  baseSteps.push({ name: generator, description: generatorDesc, state: "pending" as const });
  return baseSteps;
}

// Convert a backend snapshot's steps into the UI's StepStatus shape.
// Backend uses generic step names (generate_forge_artifact even for report
// presets internally because the registry uses one slot for the generator);
// the UI uses preset-specific descriptions. We zip them together by index.
function snapshotToSteps(snapshot: ForgeRunSnapshot, preset: RepoForgeRequest["preset"]): StepStatus[] {
  const ui = derivePipelineSteps(preset);
  const isReport = preset === "compare_apis" || (preset as string) === "migrate";
  // The backend always emits 5 step records (ingest_a, ingest_b, analyze,
  // scope, generate). For report presets the UI shows 4 steps; we fold the
  // scope step's "skipped" state into the analyze step's meta or skip it.
  const filtered = isReport
    ? snapshot.steps.filter((s) => s.name !== "scope_for_typescript")
    : snapshot.steps;
  return ui.map((u, i) => {
    const back = filtered[i];
    if (!back) return u;
    return {
      ...u,
      state: back.state,
      meta: back.meta ?? u.meta,
    };
  });
}

export function App(): JSX.Element {
  const [request, setRequest] = useState<RepoForgeRequest>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_REQUEST);
      if (raw) return { ...DEFAULT_REQUEST, ...(JSON.parse(raw) as Partial<RepoForgeRequest>) };
    } catch { /* ignore corrupt storage */ }
    return DEFAULT_REQUEST;
  });

  const [result, setResult] = useState<ForgeResponse | null>(() => {
    function tryRead(store: Storage, label: string): ForgeResponse | null {
      try {
        const raw = store.getItem(STORAGE_RESULT);
        if (!raw) return null;
        const persisted = JSON.parse(raw) as PersistedResult;
        if (typeof persisted?.saved_at !== "number") return null;
        if (Date.now() - persisted.saved_at > RESULT_TTL_MS) {
          try { store.removeItem(STORAGE_RESULT); } catch { /* ignore */ }
          return null;
        }
        if (!persisted.result || typeof persisted.result !== "object") return null;
        console.info("[marrowforge] rehydrated result from " + label + " (saved " + Math.round((Date.now() - persisted.saved_at) / 1000) + "s ago)");
        return persisted.result;
      } catch (e) {
        console.warn("[marrowforge] " + label + " parse failed, wiping:", e);
        try { store.removeItem(STORAGE_RESULT); } catch { /* ignore */ }
        return null;
      }
    }
    return tryRead(localStorage, "localStorage") ?? tryRead(sessionStorage, "sessionStorage");
  });

  // Active forge id — persisted to survive refresh. If we have one on mount
  // we'll resume polling immediately to re-attach to the running forge.
  const [forgeId, setForgeId] = useState<string | null>(() => {
    try {
      const id = localStorage.getItem(STORAGE_FORGE_ID);
      return id && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  });

  // Initial phase: if we have an active forge_id, "running" (we'll verify
  // by polling); else if we have a result, "done"; else "idle".
  const [phase, setPhase] = useState<Phase>(() => {
    try {
      if (localStorage.getItem(STORAGE_FORGE_ID)) return "running";
    } catch { /* ignore */ }
    return result ? "done" : "idle";
  });

  const [error, setError] = useState<string | null>(null);
  const [tokenVersion, setTokenVersion] = useState(0);

  // History — persisted across sessions, capped at 25 entries. Newest first.
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  // The id currently shown as "active" in the history list — set when the
  // user clicks a row OR when a fresh run completes.
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);

  // Constitution — global rules applied to every forge.
  const [constitution, setConstitution] = useState<Constitution>(() => loadConstitution());
  useEffect(() => { saveConstitution(constitution); }, [constitution]);

  // Persist request whenever it changes — easy reload story.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_REQUEST, JSON.stringify(request)); }
    catch { /* quota exceeded; ignore */ }
  }, [request]);

  // Persist result whenever a new one lands. With fallbacks for quota
  // exhaustion and storage-blocked browsers.
  useEffect(() => {
    if (phase !== "done" || !result) return;
    const persisted: PersistedResult = { result, request, saved_at: Date.now() };
    const fullJson = JSON.stringify(persisted);
    try {
      localStorage.setItem(STORAGE_RESULT, fullJson);
    } catch (e) {
      console.warn("[marrowforge] localStorage write failed, trying minimal:", e);
      try {
        const minimal: PersistedResult = {
          ...persisted,
          result: {
            ...result,
            results: {
              ...result.results,
              artifact: result.results.artifact.length > 100_000
                ? result.results.artifact.slice(0, 100_000) + "\n\n…(truncated for storage)"
                : result.results.artifact,
            },
          },
        };
        localStorage.setItem(STORAGE_RESULT, JSON.stringify(minimal));
      } catch (e2) {
        console.warn("[marrowforge] localStorage minimal write also failed; trying sessionStorage:", e2);
        try { sessionStorage.setItem(STORAGE_RESULT, fullJson); }
        catch (e3) { console.error("[marrowforge] All storage backends failed.", e3); }
      }
    }
  }, [phase, result, request]);

  // Persist forge_id whenever it changes. When phase leaves "running" we
  // wipe it so a refresh from a "done" state doesn't try to re-attach to
  // a finished run.
  useEffect(() => {
    try {
      if (forgeId && phase === "running") {
        localStorage.setItem(STORAGE_FORGE_ID, forgeId);
      } else {
        localStorage.removeItem(STORAGE_FORGE_ID);
      }
    } catch { /* ignore */ }
  }, [forgeId, phase]);

  useEffect(() => {
    const onStorage = (): void => setTokenVersion((v) => v + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const hasToken = useMemo(() => getToken().length > 0, [tokenVersion]);

  const pipelineSteps = useMemo<StepStatus[]>(() => derivePipelineSteps(request.preset), [request.preset]);

  // Runtime steps — driven by polling when phase === "running", or set to
  // "all done" / pristine pending based on phase otherwise.
  const [runtimeSteps, setRuntimeSteps] = useState<StepStatus[]>(() => {
    const initial = derivePipelineSteps(request.preset);
    if (result) return initial.map((s) => ({ ...s, state: "done" as const }));
    return initial;
  });
  useEffect(() => {
    if (phase === "running") return; // poller updates the steps
    if (phase === "done") {
      setRuntimeSteps(pipelineSteps.map((s) => ({ ...s, state: "done" as const })));
    } else if (phase === "error") {
      // keep whatever the last error path set
    } else {
      setRuntimeSteps(pipelineSteps);
    }
  }, [pipelineSteps, phase]);

  // Polling loop. Runs only when phase === "running" + we have a forge_id.
  // Updates runtimeSteps from the snapshot, and transitions phase when the
  // run finishes. The pollerRef tracks the current poll so we can cancel
  // when the user starts a new forge or cancels the current one.
  const pollerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (phase !== "running" || !forgeId) return;
    let cancelled = false;
    async function poll(): Promise<void> {
      while (!cancelled) {
        try {
          const snap = await getForgeRun(forgeId!);
          if (cancelled) return;
          // Update steps from the snapshot.
          setRuntimeSteps(snapshotToSteps(snap, request.preset));
          if (snap.status === "done" && snap.result) {
            const finishedResult: ForgeResponse = {
              ok: true,
              action: "forge_from_repos",
              trace_id: snap.trace_id,
              results: {
                repo_a: snap.result.repo_a as ForgeResponse["results"]["repo_a"],
                repo_b: snap.result.repo_b as ForgeResponse["results"]["repo_b"],
                analysis: snap.result.analysis ?? "",
                scoped: snap.result.scoped,
                artifact: snap.result.artifact ?? "",
              },
            };
            setResult(finishedResult);
            setPhase("done");
            setForgeId(null);
            // Save to history. Use the trace_id as the stable id when
            // available (lets us recognise duplicates across re-runs of the
            // same trace); fall back to a random uuid via crypto.
            const historyId = snap.trace_id ?? crypto.randomUUID();
            const historyEntry: HistoryEntry = {
              id: historyId,
              saved_at: Date.now(),
              request,
              result: finishedResult,
            };
            setHistory((prev) => {
              const next = addToHistory(historyEntry, prev);
              saveHistory(next);
              return next;
            });
            setActiveHistoryId(historyId);
            return;
          }
          if (snap.status === "error") {
            setError(snap.error ?? "Forge failed");
            setPhase("error");
            setForgeId(null);
            return;
          }
          if (snap.status === "cancelled") {
            setError("Forge cancelled");
            setPhase("error");
            setForgeId(null);
            return;
          }
        } catch (e) {
          // 404 means the run was swept (backend restarted, or > 1h after
          // finish). Treat as lost: drop back to idle so the user can retry.
          if (e instanceof Error && /404|NOT_FOUND/i.test(e.message)) {
            console.warn("[marrowforge] forge run not found on backend, dropping to idle");
            setForgeId(null);
            setPhase("idle");
            return;
          }
          // Network blip or backend down — log and keep polling.
          console.warn("[marrowforge] poll failed (will retry):", e);
        }
        await new Promise<void>((r) => {
          pollerRef.current = setTimeout(r, POLL_INTERVAL_MS);
        });
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (pollerRef.current) clearTimeout(pollerRef.current);
    };
  }, [phase, forgeId, request.preset]);

  // If we rehydrated a result, also rehydrate the trace warmup ping.
  useEffect(() => {
    if (!result?.trace_id || phase !== "done") return;
    getCognitionTrace(result.trace_id).catch(() => { /* ignore */ });
  }, [result?.trace_id, phase]);

  async function handleSubmit(): Promise<void> {
    setError(null);
    setResult(null);
    setPhase("running");
    setActiveHistoryId(null);
    setRuntimeSteps(pipelineSteps.map((s, i) => ({ ...s, state: i === 0 ? "running" : "pending" })));
    try {
      // Apply the constitution to the description before sending. The
      // backend just sees a longer description with rule clauses appended;
      // no protocol change required. Constitution is applied per-run, not
      // mutated into the persisted request, so the form keeps showing the
      // user's original prose.
      const decoratedRequest: RepoForgeRequest = {
        ...request,
        description: applyConstitutionToDescription(request.description, constitution),
      };
      const { forge_id } = await startForgeRun(decoratedRequest);
      setForgeId(forge_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
      setPhase("error");
      setRuntimeSteps(pipelineSteps.map((s, i) => ({ ...s, state: i === 0 ? "error" : "pending" })));
    }
  }

  function handleSelectHistory(entry: HistoryEntry): void {
    // Clicking a history row loads the archived run back into the workspace.
    // We intentionally don't reset the request — users may want to compare
    // the previous output against a slightly tweaked re-run.
    setResult(entry.result);
    setActiveHistoryId(entry.id);
    setPhase("done");
    setError(null);
    setForgeId(null);
    // Sync the form to the request that produced this run so the user sees
    // exactly what was forged. The current draft is preserved in localStorage
    // and re-applied on the next page load.
    setRequest(entry.request);
  }

  function handleDeleteHistory(id: string): void {
    setHistory((prev) => {
      const next = removeFromHistory(id, prev);
      saveHistory(next);
      return next;
    });
    if (activeHistoryId === id) setActiveHistoryId(null);
  }

  function handleClearAllHistory(): void {
    setHistory([]);
    saveHistory([]);
    setActiveHistoryId(null);
  }

  async function handleCancel(): Promise<void> {
    if (!forgeId) return;
    try {
      await cancelForgeRun(forgeId);
      // The poller will see status: "cancelled" and transition us.
    } catch (e) {
      console.warn("[marrowforge] cancel request failed:", e);
    }
  }

  function handleClearResult(): void {
    setResult(null);
    setPhase("idle");
    setError(null);
    setForgeId(null);
    try {
      localStorage.removeItem(STORAGE_RESULT);
      localStorage.removeItem(STORAGE_FORGE_ID);
    } catch { /* ignore */ }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <span className="brand-name">MarrowForge</span>
            <span className="brand-tag">deterministic forge</span>
          </div>
        </div>
        <div onClick={() => setTokenVersion((v) => v + 1)}>
          <ConnectionPill />
        </div>
      </header>

      <main className="app-main">
        <TokenBar onChange={() => setTokenVersion((v) => v + 1)} />

        <motion.div
          className="workspace"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* ── Sidebar — history + constitution ─────────────────────── */}
          <aside className="sidebar">
            <HistorySidebar
              entries={history}
              activeId={activeHistoryId}
              onSelect={handleSelectHistory}
              onDelete={handleDeleteHistory}
              onClearAll={handleClearAllHistory}
            />
            <ConstitutionPanel value={constitution} onChange={setConstitution} />
          </aside>

          {/* ── Main column — request form, then result ──────────────── */}
          <section className="workspace-main">
            <RequestPanel
              value={request}
              onChange={setRequest}
              onSubmit={handleSubmit}
              isLoading={phase === "running"}
              hasToken={hasToken}
              onCancel={phase === "running" && forgeId ? handleCancel : undefined}
            />
            {/* Mid-width fallback: when the inspector is hidden by the
                breakpoint, pipeline still needs a home. CSS class
                `inspector-hidden-only` only shows this on viewports below
                1200px. Above that the inspector handles it. */}
            <div className="inspector-hidden-only">
              <PipelineProgress steps={runtimeSteps} preset={request.preset} />
            </div>
            <ResultPanel
              result={result}
              isLoading={phase === "running"}
              error={error}
              onClear={handleClearResult}
            />
          </section>

          {/* ── Inspector right rail — pipeline + run metadata ───────── */}
          <aside className="inspector">
            <InspectorPanel
              steps={runtimeSteps}
              result={result}
              isLoading={phase === "running"}
              forgeId={forgeId}
            />
          </aside>
        </motion.div>
      </main>

      <footer className="app-footer">
        <span>API <code>/api → http://localhost:3000</code></span>
        <span>UI <code>localhost:5173</code></span>
        <span>Theme <code>black · silver</code></span>
      </footer>
    </div>
  );
}
