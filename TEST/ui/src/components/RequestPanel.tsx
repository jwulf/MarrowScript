import { motion } from "framer-motion";
import type { Preset, RepoForgeRequest } from "../api";
import { PRESETS } from "../api";
import { Slider } from "./Slider";

interface Props {
  value: RepoForgeRequest;
  onChange: (v: RepoForgeRequest) => void;
  onSubmit: () => void;
  isLoading: boolean;
  hasToken: boolean;
  /** Optional cancel callback. When provided AND isLoading is true, a
   *  Cancel button appears next to the Forge button so the user can
   *  abort an in-flight forge. */
  onCancel?: () => void;
}

// Sensible default target_path per preset. The LLM uses this hint to
// pick the right file shape (a .md path gets markdown, a .ts path gets
// TypeScript, etc.). Users can still override the value after picking
// a preset — we only set the path if the field is empty or still on a
// previous preset's default.
const PRESET_PATHS: Record<Preset, string> = {
  compare_apis: "REPORT.md",
  compat_layer: "src/adapter.ts",
  bridge:       "src/bridge.ts",
  extract:      "src/extracted/index.ts",
  combine:      "src/combined/index.ts",
  port_a_to_b:  "src/ported.ts",
  port_b_to_a:  "src/ported.ts",
};
const PRESET_PATH_VALUES = new Set(Object.values(PRESET_PATHS));

// The request panel. Three sections, all editable:
//   1. Two URL inputs (repo A + B), with refs.
//   2. Preset chip strip — clicking auto-bumps the complexity slider so the
//      user starts in the right tier for that preset.
//   3. Title + description, plus a complexity slider with bucket marks.
// Hitting Forge fires the parent's onSubmit callback.

export function RequestPanel({ value, onChange, onSubmit, isLoading, hasToken, onCancel }: Props): JSX.Element {
  function set<K extends keyof RepoForgeRequest>(key: K, v: RepoForgeRequest[K]): void {
    onChange({ ...value, [key]: v });
  }

  function selectPreset(p: Preset): void {
    const meta = PRESETS.find((x) => x.id === p);
    // Auto-update target_path when:
    //   - it's empty, or
    //   - it still holds a default from a previous preset (we only stomp
    //     our own defaults so a user-typed path is preserved across preset
    //     switches).
    const stale = !value.target_path.trim() || PRESET_PATH_VALUES.has(value.target_path.trim());
    onChange({
      ...value,
      preset: p,
      complexity: meta?.complexity ?? value.complexity,
      target_path: stale ? PRESET_PATHS[p] : value.target_path,
    });
  }

  const canSubmit =
    hasToken &&
    !isLoading &&
    value.repo_a_url.trim().length > 0 &&
    value.repo_b_url.trim().length > 0 &&
    value.description.trim().length > 0;

  // What's keeping the button disabled? Surface the reason so users don't
  // have to guess at field validation rules.
  const disabledReason = (() => {
    if (isLoading) return null;
    if (!hasToken) return "Paste a JWT in the Token bar above";
    if (!value.repo_a_url.trim()) return "Set Repo A URL";
    if (!value.repo_b_url.trim()) return "Set Repo B URL";
    if (!value.description.trim()) return "Add a description";
    return null;
  })();

  return (
    <motion.section
      className="card"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="card-header">
        <h2><span className="card-step-badge">1</span> Compose request</h2>
      </div>

      <div className="row">
        <div className="field">
          <label>Repo A <span className="helper">source</span></label>
          <input
            type="url"
            value={value.repo_a_url}
            onChange={(e) => set("repo_a_url", e.target.value)}
            placeholder="https://github.com/owner/repo-a"
            spellCheck={false}
          />
        </div>
        <div className="field" style={{ maxWidth: "120px" }}>
          <label>Ref</label>
          <input
            type="text"
            value={value.repo_a_ref}
            onChange={(e) => set("repo_a_ref", e.target.value)}
            placeholder="HEAD"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label>Repo B <span className="helper">target / partner</span></label>
          <input
            type="url"
            value={value.repo_b_url}
            onChange={(e) => set("repo_b_url", e.target.value)}
            placeholder="https://github.com/owner/repo-b"
            spellCheck={false}
          />
        </div>
        <div className="field" style={{ maxWidth: "120px" }}>
          <label>Ref</label>
          <input
            type="text"
            value={value.repo_b_ref}
            onChange={(e) => set("repo_b_ref", e.target.value)}
            placeholder="HEAD"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="field">
        <label>Preset <span className="helper">how to combine</span></label>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <motion.button
              key={p.id}
              className="preset-chip"
              data-selected={value.preset === p.id}
              onClick={() => selectPreset(p.id)}
              type="button"
              whileTap={{ scale: 0.97 }}
              whileHover={{ y: -1 }}
              transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            >
              <span className="name">{p.name}</span>
              <span className="desc">{p.desc}</span>
            </motion.button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>
          Title
          <span className="helper">{value.title.length}/80</span>
        </label>
        <input
          type="text"
          value={value.title}
          onChange={(e) => set("title", e.target.value.slice(0, 80))}
          placeholder="One-line summary of what you want"
          spellCheck={false}
        />
      </div>

      <div className="field">
        <label>
          Description
          <span className="helper">{value.description.length} chars</span>
        </label>
        <textarea
          value={value.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What should the forge produce? Be specific about inputs, outputs, and any constraints."
          rows={4}
          spellCheck={false}
        />
      </div>

      <div className="field">
        <label>
          Complexity
          <span className="helper">router cutoff at 0.7 → DeepSeek</span>
        </label>
        <Slider
          value={value.complexity}
          onChange={(v) => set("complexity", v)}
          min={0}
          max={1}
          step={0.05}
          marks={[
            { value: 0.10, label: "trivial" },
            { value: 0.35, label: "simple" },
            { value: 0.55, label: "moderate" },
            { value: 0.7,  label: "tier ↑" },
            { value: 0.85, label: "heavy" },
            { value: 1.00, label: "max" },
          ]}
        />
      </div>

      <div className="field">
        <label>Target path <span className="helper">where the artifact lands</span></label>
        <input
          type="text"
          value={value.target_path}
          onChange={(e) => set("target_path", e.target.value)}
          placeholder="src/adapter.ts"
          spellCheck={false}
          className="mono"
        />
      </div>

      {!hasToken && (
        <motion.div
          className="notice"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.3 }}
          style={{ marginBottom: 16 }}
        >
          <span className="icon">!</span>
          <div className="body">
            <div className="title">Token required</div>
            <div className="detail">
              Run <code>npx ts-node bin/mint_dev_token.ts --sub frontend-dev</code> in the backend folder, then paste the token above.
            </div>
          </div>
        </motion.div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <motion.button
          className="btn btn-block"
          onClick={onSubmit}
          disabled={!canSubmit}
          whileTap={canSubmit ? { scale: 0.98 } : {}}
          whileHover={canSubmit ? { scale: 1.005 } : {}}
          transition={{ duration: 0.15 }}
          style={{ flex: 1 }}
        >
          {isLoading ? (
            <>
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}
                style={{ display: "inline-block", width: 14, height: 14, borderRadius: "50%", border: "2px solid #0a0a0a", borderTopColor: "transparent" }}
              />
              Forging…
            </>
          ) : (
            <>Forge ↪</>
          )}
        </motion.button>
        {isLoading && onCancel && (
          <motion.button
            className="btn btn-secondary"
            onClick={onCancel}
            whileTap={{ scale: 0.98 }}
            whileHover={{ scale: 1.005 }}
            transition={{ duration: 0.15 }}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            style={{ minWidth: 120 }}
          >
            Cancel
          </motion.button>
        )}
      </div>
      {disabledReason && (
        <div className="muted tiny" style={{ textAlign: "center", marginTop: 10 }}>
          {disabledReason}
        </div>
      )}
    </motion.section>
  );
}
