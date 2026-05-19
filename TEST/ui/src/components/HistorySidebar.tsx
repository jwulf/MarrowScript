import { motion, AnimatePresence } from "framer-motion";
import { formatAge, summarize, type HistoryEntry } from "../history";

interface Props {
  entries: HistoryEntry[];
  activeId: string | null;
  onSelect: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
}

// Renders the forge run history. Each entry is clickable to load the
// archived result back into the workspace; hover reveals a delete button.
// The active entry (current result loaded) is highlighted.

export function HistorySidebar({ entries, activeId, onSelect, onDelete, onClearAll }: Props): JSX.Element {
  return (
    <motion.div
      className="side-card"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="side-card-header">
        <span className="side-card-title">
          History {entries.length > 0 && <span className="muted">· {entries.length}</span>}
        </span>
        {entries.length > 0 && (
          <button className="side-card-action" onClick={onClearAll} title="Clear all history">
            Clear
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="history-empty">No runs yet. Hit Forge to start.</div>
      ) : (
        <div className="history-list">
          <AnimatePresence initial={false}>
            {entries.map((entry) => (
              <motion.button
                key={entry.id}
                className="history-item"
                data-active={entry.id === activeId}
                onClick={() => onSelect(entry)}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
              >
                <div className="row-1">
                  <span className="preset">{entry.request.preset}</span>
                  <span className="age">{formatAge(entry.saved_at)}</span>
                </div>
                <div className="summary">{summarize(entry)}</div>
                <div className="row-2">
                  {entry.result.results?.scoped && (
                    <span className="badge mono" style={{ padding: "1px 6px", fontSize: 10 }}>scoped</span>
                  )}
                  {entry.artifact_truncated && (
                    <span className="badge badge-warn mono" style={{ padding: "1px 6px", fontSize: 10 }}>truncated</span>
                  )}
                </div>
                <button
                  className="delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(entry.id);
                  }}
                  title="Remove from history"
                  aria-label="Remove"
                >×</button>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}
