import { motion, AnimatePresence } from "framer-motion";
import type { Preset } from "../api";

export type StepState = "pending" | "running" | "done" | "error";

export interface StepStatus {
  name: string;
  description: string;
  state: StepState;
  meta?: string;
}

interface Props {
  steps: StepStatus[];
  preset: Preset;
}

// Vertical stepper. Each step has an indicator (pending = outline, running =
// pulsing ring, done = green dot, error = red dot) plus a label and a meta
// column for things like elapsed time. The whole list animates in.

export function PipelineProgress({ steps }: Props): JSX.Element {
  return (
    <motion.section
      className="card"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
    >
      <div className="card-header">
        <h2><span className="card-step-badge">2</span> Pipeline</h2>
        {steps.some((s) => s.state === "running") && (
          <span className="badge badge-warn">running</span>
        )}
        {steps.length > 0 && steps.every((s) => s.state === "done") && (
          <span className="badge badge-ok">complete</span>
        )}
        {steps.some((s) => s.state === "error") && (
          <span className="badge badge-danger">failed</span>
        )}
      </div>

      <div className="pipeline">
        <AnimatePresence initial={false}>
          {steps.map((s, i) => (
            <motion.div
              key={s.name + i}
              className="pipeline-step"
              data-state={s.state}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1], delay: i * 0.04 }}
            >
              <span className="indicator" aria-hidden />
              <div className="label">
                <span className="name">{s.name}</span>
                <span className="desc">{s.description}</span>
              </div>
              <div className="meta">
                {s.meta ?? ""}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
