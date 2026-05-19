import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PRESET_RULES, type Constitution } from "../constitution";

interface Props {
  value: Constitution;
  onChange: (c: Constitution) => void;
}

// Constitution panel — borrowed from spec-kit's /speckit.constitution. Lets
// the user define project-level rules that get appended to every forge's
// description. Two flavours: preset toggles (common constraints) and
// free-text custom rules.

export function ConstitutionPanel({ value, onChange }: Props): JSX.Element {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);

  function togglePreset(id: string): void {
    onChange({ ...value, presetFlags: { ...value.presetFlags, [id]: !value.presetFlags[id] } });
  }

  function addRule(): void {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange({ ...value, customRules: [...value.customRules, trimmed] });
    setDraft("");
  }

  function removeRule(idx: number): void {
    onChange({ ...value, customRules: value.customRules.filter((_, i) => i !== idx) });
  }

  const activeCount =
    value.customRules.filter((r) => r.trim()).length +
    Object.values(value.presetFlags).filter(Boolean).length;

  return (
    <motion.div
      className="side-card"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
    >
      <div className="side-card-header">
        <span className="side-card-title">
          Constitution {activeCount > 0 && <span className="muted">· {activeCount}</span>}
        </span>
        <button
          className="side-card-action"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "Collapse" : "Edit"}
        </button>
      </div>

      {/* Custom rules — always visible as chips. */}
      {value.customRules.length > 0 && (
        <div className="rule-list">
          <AnimatePresence initial={false}>
            {value.customRules.map((rule, i) => (
              <motion.span
                key={i + ":" + rule}
                className="rule-chip"
                title={rule}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.18 }}
              >
                <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {rule}
                </span>
                <button className="x" onClick={() => removeRule(i)} aria-label="Remove">×</button>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* When collapsed and there are NO custom rules, show a hint. */}
      {value.customRules.length === 0 && !expanded && (
        <div className="muted tiny" style={{ marginTop: 4 }}>
          {activeCount > 0
            ? activeCount + " preset rule" + (activeCount === 1 ? "" : "s") + " active. Click Edit to manage."
            : "No rules. Click Edit to add some."}
        </div>
      )}

      {/* Expanded view: add rule input + preset toggles. */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div className="rule-add">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addRule(); }}
                placeholder="e.g. Don't introduce new dependencies"
                spellCheck={false}
              />
              <button onClick={addRule} disabled={!draft.trim()}>Add</button>
            </div>

            <div className="preset-rule-section">
              <div className="label">Preset rules</div>
              {PRESET_RULES.map((preset) => (
                <label key={preset.id} className="preset-rule-row">
                  <input
                    type="checkbox"
                    checked={!!value.presetFlags[preset.id]}
                    onChange={() => togglePreset(preset.id)}
                  />
                  <span className="text">{preset.label}</span>
                </label>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
