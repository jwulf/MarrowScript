import { motion } from "framer-motion";
import type { ForgeResponse } from "../api";
import type { StepStatus } from "./PipelineProgress";

interface Props {
  steps: StepStatus[];
  result: ForgeResponse | null;
  isLoading: boolean;
  forgeId: string | null;
}

// The right rail. Always shows pipeline progress + a small metadata block.
// When a result is present we add token / cost / artifact-size figures so
// the user can see resource usage at a glance.

export function InspectorPanel({ steps, result, isLoading, forgeId }: Props): JSX.Element {
  // Fold the pipeline steps into a status summary for the inspector.
  const total = steps.length;
  const done = steps.filter((s) => s.state === "done").length;
  const running = steps.filter((s) => s.state === "running").length;
  const errored = steps.filter((s) => s.state === "error").length;

  const overall = errored > 0 ? "errored" : isLoading ? "running" : done === total && total > 0 ? "complete" : "idle";

  return (
    <>
      <motion.div
        className="side-card"
        initial={{ opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="side-card-header">
          <span className="side-card-title">Run status</span>
        </div>
        <div className="inspector-stat">
          <span className="k">Overall</span>
          <span className={
            "v " + (overall === "complete" ? "ok" : overall === "errored" ? "danger" : overall === "running" ? "warn" : "")
          }>{overall}</span>
        </div>
        <div className="inspector-stat">
          <span className="k">Steps</span>
          <span className="v">{done} / {total} done</span>
        </div>
        {running > 0 && (
          <div className="inspector-stat">
            <span className="k">In-flight</span>
            <span className="v warn">{running}</span>
          </div>
        )}
        {forgeId && (
          <div className="inspector-stat">
            <span className="k">Run id</span>
            <span className="v" style={{ fontSize: 11 }}>{forgeId.slice(0, 8)}…</span>
          </div>
        )}
        {result?.trace_id && (
          <div className="inspector-stat">
            <span className="k">Trace id</span>
            <span className="v" style={{ fontSize: 11 }}>{result.trace_id.slice(0, 8)}…</span>
          </div>
        )}
      </motion.div>

      {/* Pipeline visualisation — same data as the dedicated step list, but
          slim and condensed for the rail. The full list still lives in the
          main column for users who want it big. */}
      <motion.div
        className="side-card"
        initial={{ opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
      >
        <div className="side-card-header">
          <span className="side-card-title">Pipeline</span>
        </div>
        <div className="pipeline" style={{ marginTop: -4 }}>
          {steps.map((s, i) => (
            <div key={s.name + i} className="pipeline-step" data-state={s.state} style={{ padding: "8px 0" }}>
              <span className="indicator" aria-hidden />
              <div className="label">
                <span className="name" style={{ fontSize: 12 }}>{s.name.replace(/_/g, " ")}</span>
              </div>
              <div className="meta" style={{ fontSize: 10 }}>
                {s.meta && <span>{s.meta}</span>}
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Resource usage card — only when we have a result. */}
      {result && (
        <motion.div
          className="side-card"
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
        >
          <div className="side-card-header">
            <span className="side-card-title">Resources</span>
          </div>
          <div className="inspector-stat">
            <span className="k">Artifact</span>
            <span className="v">{(result.results.artifact?.length ?? 0).toLocaleString()} chars</span>
          </div>
          <div className="inspector-stat">
            <span className="k">Repo A files</span>
            <span className="v">{result.results.repo_a?.file_count?.toLocaleString() ?? "—"}</span>
          </div>
          <div className="inspector-stat">
            <span className="k">Repo B files</span>
            <span className="v">{result.results.repo_b?.file_count?.toLocaleString() ?? "—"}</span>
          </div>
        </motion.div>
      )}
    </>
  );
}
