// Forge history persistence. Lives separately from the live `result` cache so
// we keep multiple runs around (max 25), each browsable, replayable, and
// deletable.
//
// Storage layout: `marrowforge_history` -> JSON array of HistoryEntry, newest
// first. We cap at 25 entries. Larger artifacts get truncated to keep the
// whole list under the localStorage quota — same fallback strategy as the
// live result cache.

import type { ForgeResponse, RepoForgeRequest } from "./api";

export interface HistoryEntry {
  /** Stable id — the trace_id when available, otherwise a random uuid. */
  id: string;
  /** Wall-clock timestamp when the run completed. */
  saved_at: number;
  /** The request that produced this run. */
  request: RepoForgeRequest;
  /** The full response, possibly with a truncated artifact field. */
  result: ForgeResponse;
  /** Whether artifact was truncated to fit storage quota. */
  artifact_truncated?: boolean;
}

const STORAGE_KEY = "marrowforge_history";
const MAX_ENTRIES = 25;
const MAX_ARTIFACT_CHARS = 50_000;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop entries missing required fields.
    return parsed.filter(
      (e) => e && typeof e.id === "string" && typeof e.saved_at === "number" && e.result && e.request,
    );
  } catch (e) {
    console.warn("[marrowforge] history load failed, wiping:", e);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[]): void {
  // Cap at MAX_ENTRIES, drop oldest. Newest always at index 0.
  const capped = entries.slice(0, MAX_ENTRIES);
  // Truncate large artifact fields so the total payload stays well under
  // 5MB (typical localStorage quota). One run with a 200KB artifact x 25
  // entries = 5MB. We stay safe by truncating any artifact over 50KB.
  const trimmed = capped.map((e) => {
    if (e.result?.results?.artifact && e.result.results.artifact.length > MAX_ARTIFACT_CHARS) {
      return {
        ...e,
        result: {
          ...e.result,
          results: {
            ...e.result.results,
            artifact: e.result.results.artifact.slice(0, MAX_ARTIFACT_CHARS) + "\n\n…(truncated for history)",
          },
        },
        artifact_truncated: true,
      };
    }
    return e;
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("[marrowforge] history save failed, dropping oldest entries and retrying:", e);
    // Quota exceeded — try with half the entries.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed.slice(0, Math.floor(trimmed.length / 2))));
    } catch (e2) {
      console.error("[marrowforge] history save failed even after halving:", e2);
    }
  }
}

export function addToHistory(entry: HistoryEntry, existing: HistoryEntry[]): HistoryEntry[] {
  // Avoid duplicate ids — replace if same id, else prepend.
  const dedup = existing.filter((e) => e.id !== entry.id);
  return [entry, ...dedup];
}

export function removeFromHistory(id: string, existing: HistoryEntry[]): HistoryEntry[] {
  return existing.filter((e) => e.id !== id);
}

/** Format a timestamp as a relative age string for the sidebar. */
export function formatAge(savedAt: number): string {
  const elapsed = Date.now() - savedAt;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  const days = Math.floor(hours / 24);
  return days + "d";
}

/** Derive a one-line summary from a history entry for the list view. */
export function summarize(entry: HistoryEntry): string {
  // Prefer the request title; fall back to the description's first 60 chars.
  const t = entry.request.title?.trim();
  if (t) return t;
  const d = entry.request.description?.trim() ?? "";
  return d.length > 60 ? d.slice(0, 60) + "…" : d;
}
