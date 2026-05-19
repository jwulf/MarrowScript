import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ForgeResponse, TraceResponse } from "../api";
import { getCognitionTrace } from "../api";

type Tab = "artifact" | "scope" | "analysis" | "repos" | "trace";

interface Props {
  result: ForgeResponse | null;
  isLoading: boolean;
  error: string | null;
  /** Optional: called when the user clicks "Clear" on a stale result. */
  onClear?: () => void;
}

// The right-hand panel. When idle: empty state. When forging: a soft
// "thinking" overlay. When done: tabbed view of the artifact, the analysis
// JSON, the repo summaries, and the cognition trace timeline.

export function ResultPanel({ result, isLoading, error, onClear }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>("artifact");
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [traceErr, setTraceErr] = useState<string | null>(null);

  // Reset to artifact tab whenever a new result arrives.
  useEffect(() => {
    if (result) setTab("artifact");
  }, [result?.trace_id]);

  // Auto-load the trace when the result has one.
  useEffect(() => {
    setTrace(null);
    setTraceErr(null);
    if (!result?.trace_id) return;
    let cancelled = false;
    getCognitionTrace(result.trace_id)
      .then((t) => { if (!cancelled) setTrace(t); })
      .catch((err: Error) => { if (!cancelled) setTraceErr(err.message); });
    return () => { cancelled = true; };
  }, [result?.trace_id]);

  if (error) {
    return (
      <motion.section
        className="card"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="card-header">
          <h2><span className="card-step-badge">3</span> Result</h2>
          <span className="badge badge-danger">error</span>
        </div>
        <div className="notice">
          <span className="icon">!</span>
          <div className="body">
            <div className="title">Forge failed</div>
            <div className="detail">{error}</div>
          </div>
        </div>
      </motion.section>
    );
  }

  if (isLoading && !result) {
    return (
      <motion.section
        className="card"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="card-header">
          <h2><span className="card-step-badge">3</span> Result</h2>
          <span className="badge badge-warn">pending</span>
        </div>
        <ThinkingIndicator />
      </motion.section>
    );
  }

  if (!result) {
    return (
      <motion.section
        className="card"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="card-header">
          <h2><span className="card-step-badge">3</span> Result</h2>
        </div>
        <div className="empty">
          <div className="glyph">⤳</div>
          <h2>Nothing forged yet</h2>
          <p>Compose a request on the left and hit Forge. The artifact, analysis, and trace will appear here.</p>
        </div>
      </motion.section>
    );
  }

  return (
    <motion.section
      className="card"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="card-header">
        <h2><span className="card-step-badge">3</span> Result</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="badge badge-ok">ok</span>
          {onClear && (
            <button
              className="copy-btn"
              onClick={onClear}
              title="Clear this result and reset for a new forge"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="artifact-toolbar">
        <div className="tab-row">
          <button data-active={tab === "artifact"} onClick={() => setTab("artifact")}>Artifact</button>
          {result.results.scoped !== undefined && (
            <button data-active={tab === "scope"} onClick={() => setTab("scope")}>Scope</button>
          )}
          <button data-active={tab === "analysis"} onClick={() => setTab("analysis")}>Analysis</button>
          <button data-active={tab === "repos"}    onClick={() => setTab("repos")}>Repos</button>
          <button data-active={tab === "trace"}    onClick={() => setTab("trace")}>
            Trace {trace && <span className="muted">({trace.span_count})</span>}
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          {tab === "artifact"  && <ArtifactView text={result.results.artifact} />}
          {tab === "scope"     && result.results.scoped !== undefined && <ScopeView raw={result.results.scoped} />}
          {tab === "analysis"  && <AnalysisView raw={result.results.analysis} />}
          {tab === "repos"     && <ReposView a={result.results.repo_a} b={result.results.repo_b} />}
          {tab === "trace"     && <TraceView trace={trace} error={traceErr} traceId={result.trace_id} />}
        </motion.div>
      </AnimatePresence>
    </motion.section>
  );
}

function ThinkingIndicator(): JSX.Element {
  return (
    <div className="empty">
      <motion.div
        className="glyph"
        animate={{ scale: [1, 1.1, 1] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      >
        ⌬
      </motion.div>
      <h2>Forging</h2>
      <p>
        Cloning repos · running analysis on Tiny · routing through the forge_router · generating the artifact.
        Slow free-tier providers can take 30-60 seconds. The trace will populate when complete.
      </p>
    </div>
  );
}

function ArtifactView({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked, ignore */ }
  };

  return (
    <>
      <div className="artifact-toolbar">
        <span className="muted tiny">{text.length.toLocaleString()} characters</span>
        <button className="copy-btn" onClick={onCopy}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
      <div className="artifact">{text}</div>
    </>
  );
}

// Renders the scoping pass output. The shape is:
//   { feasibility, revised_plan, target_symbol, complexity, out_of_scope, caveats }
// Surfaces feasibility prominently with a colour-coded badge so the user sees
// at a glance whether the request was achievable, partial, or stub-modeed.
function ScopeView({ raw }: { raw: string }): JSX.Element {
  const parsed = useMemo<Record<string, unknown> | null>(() => {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }, [raw]);

  if (!parsed) {
    return (
      <>
        <div className="artifact-toolbar">
          <span className="muted tiny">Raw scoping output (not valid JSON)</span>
        </div>
        <div className="artifact">{raw}</div>
      </>
    );
  }

  const feasibility = String(parsed.feasibility ?? "unknown");
  const revisedPlan = String(parsed.revised_plan ?? "");
  const targetSymbol = String(parsed.target_symbol ?? "");
  const complexity = typeof parsed.complexity === "number" ? parsed.complexity : null;
  const outOfScope = Array.isArray(parsed.out_of_scope) ? (parsed.out_of_scope as unknown[]).map(String) : [];
  const caveats = Array.isArray(parsed.caveats) ? (parsed.caveats as unknown[]).map(String) : [];

  const feasibilityBadge =
    feasibility === "full"          ? "badge badge-ok"      :
    feasibility === "partial"       ? "badge badge-warn"    :
    feasibility === "not_achievable" ? "badge badge-danger" :
                                       "badge";

  const feasibilityCopy =
    feasibility === "full"          ? "Full TypeScript implementation possible." :
    feasibility === "partial"       ? "TypeScript can do part of the job. Some pieces are out of scope." :
    feasibility === "not_achievable" ? "Cannot be a TypeScript file. Generated as documented stub." :
                                       "Scoping verdict unclear.";

  return (
    <>
      <div className="artifact-toolbar">
        <span className={feasibilityBadge}>{feasibility}</span>
        <span className="muted tiny" style={{ marginLeft: 8 }}>{feasibilityCopy}</span>
      </div>
      <div className="kv-list">
        {targetSymbol && (
          <div className="kv-row"><span className="k">Target symbol</span><span className="v mono">{targetSymbol}</span></div>
        )}
        {complexity !== null && (
          <div className="kv-row"><span className="k">Complexity</span><span className="v mono">{complexity.toFixed(2)}</span></div>
        )}
        {revisedPlan && (
          <div className="kv-row"><span className="k">Revised plan</span><span className="v" style={{ whiteSpace: "pre-wrap" }}>{revisedPlan}</span></div>
        )}
        {outOfScope.length > 0 && (
          <div className="kv-row">
            <span className="k">Out of scope</span>
            <span className="v">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {outOfScope.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </span>
          </div>
        )}
        {caveats.length > 0 && (
          <div className="kv-row">
            <span className="k">Caveats</span>
            <span className="v">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {caveats.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </span>
          </div>
        )}
      </div>
    </>
  );
}

function AnalysisView({ raw }: { raw: string }): JSX.Element {
  const parsed = useMemo<Record<string, unknown> | null>(() => {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }, [raw]);

  if (!parsed) {
    return (
      <>
        <div className="artifact-toolbar">
          <span className="muted tiny">Raw model output (not valid JSON)</span>
        </div>
        <div className="artifact">{raw}</div>
      </>
    );
  }

  return (
    <div className="kv-list">
      {Object.entries(parsed).map(([k, v]) => (
        <div key={k} className="kv-row">
          <span className="k">{k}</span>
          <span className="v mono">
            {Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ReposView({ a, b }: { a: ForgeResponse["results"]["repo_a"]; b: ForgeResponse["results"]["repo_b"] }): JSX.Element {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
      {[a, b].map((r, i) => (
        <div key={i} className="kv-list">
          <h3>Repo {i === 0 ? "A" : "B"}</h3>
          <div className="kv-row"><span className="k">URL</span>      <span className="v mono">{r.url_redacted}</span></div>
          <div className="kv-row"><span className="k">Ref</span>      <span className="v mono">{r.ref}</span></div>
          <div className="kv-row"><span className="k">Head</span>     <span className="v mono">{r.head_sha.slice(0, 12)}…</span></div>
          <div className="kv-row"><span className="k">Files</span>    <span className="v">{r.file_count.toLocaleString()}</span></div>
          <div className="kv-row"><span className="k">Bytes</span>    <span className="v">{r.total_bytes.toLocaleString()}</span></div>
          <div className="kv-row"><span className="k">Cached</span>   <span className="v">{r.cached ? "yes" : "no (fresh clone)"}</span></div>
        </div>
      ))}
    </div>
  );
}

function TraceView({ trace, error, traceId }: { trace: TraceResponse | null; error: string | null; traceId: string | null }): JSX.Element {
  if (error) {
    return (
      <div className="notice">
        <span className="icon">!</span>
        <div className="body">
          <div className="title">Couldn't load trace</div>
          <div className="detail">{error}</div>
        </div>
      </div>
    );
  }

  if (!trace) {
    return (
      <div className="empty" style={{ padding: 40 }}>
        <motion.div
          className="glyph"
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
        >
          ◌
        </motion.div>
        <p>{traceId ? `Loading trace ${traceId.slice(0, 8)}…` : "No trace_id."}</p>
      </div>
    );
  }

  return (
    <>
      <div className="artifact-toolbar">
        <span className="muted tiny">trace_id <span className="mono">{trace.trace_id.slice(0, 12)}…</span></span>
        <span className="muted tiny" style={{ marginLeft: 8 }}>· {trace.span_count} spans</span>
      </div>
      <div className="trace-list">
        {trace.spans.map((span) => (
          <motion.div
            key={span.span_id}
            className="trace-item"
            data-status={span.status}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25 }}
          >
            <span className="kind">{span.kind}</span>
            <span className="status">{span.status}</span>
            <span className="label-row">
              {span.prompt && <span className="muted">{span.prompt}</span>}
              {span.model && <span className="badge mono" style={{ padding: "2px 6px" }}>{span.model}</span>}
              {span.cache_hit && <span className="badge badge-ok mono" style={{ padding: "2px 6px" }}>cache</span>}
              {typeof span.confidence === "number" && (
                <span className="muted mono">conf {span.confidence.toFixed(2)}</span>
              )}
            </span>
            <span className="latency">
              {span.latency_ms}ms
              {(span.prompt_tokens || span.completion_tokens) && (
                <div className="tiny muted">{span.prompt_tokens ?? 0} in / {span.completion_tokens ?? 0} out</div>
              )}
            </span>
          </motion.div>
        ))}
      </div>
    </>
  );
}
