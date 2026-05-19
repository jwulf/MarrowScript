/**
 * MarrowScript Router Tuner — auto-rewrite (Phase 19 v2.5)
 *
 * When `--apply` is passed to `marrowc tune-router`, this module computes
 * safe threshold edits from the tuner's report and applies them in-place
 * to the .marrow source file. Scope is deliberately narrow:
 *
 *   - Only edits tier `max:` thresholds
 *   - Only acts on pattern 3 suggestions ("cheap tier passes everything →
 *     raise max")
 *   - Preserves all comments, whitespace, and unrelated lines
 *   - Writes a backup to `<file>.bak` before modifying
 *   - Rejects edits that would exceed 1.0 (the tier ladder's upper bound)
 *
 * Philosophy: the .marrow source is sacred. Auto-rewrite is a convenience,
 * not an optimization solver. Humans review the diff before committing.
 */

import * as fs from "fs";
import type { TuneReport } from "./tune_router";
import type * as IR from "./ir";

export interface RewriteEdit {
  /** The tier being edited. */
  tier: string;
  /** Old max value in the source (null = default tier). */
  oldMax: number | null;
  /** New max value. */
  newMax: number;
  /** Line number in the source (1-based) where the edit was applied. */
  line: number;
  /** The suggestion string that triggered this edit. */
  reason: string;
}

export interface RewriteResult {
  applied: RewriteEdit[];
  skipped: string[];
  /** True if the file was modified on disk. */
  written: boolean;
}

/**
 * Compute and apply safe max-threshold edits from a tune report. Only acts
 * on pattern 3 suggestions: "cheap tier passes everything → raise max".
 *
 * The heuristic: when a tier meets all policy constraints over ≥50 calls,
 * we raise its `max:` by 0.1 (capped at 0.95 so the default tier still
 * captures something). This is conservative — the human can push further
 * in review.
 */
export function applyTuneRewrites(
  specPath: string,
  router: IR.IRRouter,
  report: TuneReport,
): RewriteResult {
  const applied: RewriteEdit[] = [];
  const skipped: string[] = [];

  // Only act on pattern 3 suggestions (contain "raising max").
  const raiseMax = report.suggestions.filter(s => s.includes("raising max"));
  if (raiseMax.length === 0) {
    return { applied: [], skipped: ["no applicable suggestions (only 'raise max' pattern is auto-applied)"], written: false };
  }

  const source = fs.readFileSync(specPath, "utf-8");
  const lines = source.split(/\r?\n/);
  let modified = false;

  for (const suggestion of raiseMax) {
    // Extract the tier name from the suggestion: "<tierName>: meets all policy..."
    const m = suggestion.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*meets all policy/);
    if (!m) { skipped.push(`couldn't parse tier from: ${suggestion.slice(0, 80)}`); continue; }
    const tierName = m[1];
    const tierIR = router.tiers.find(t => t.name === tierName);
    if (!tierIR || tierIR.max === null) { skipped.push(`${tierName}: no current max (default tier — can't raise)`); continue; }

    const newMax = Math.round((tierIR.max + 0.1) * 100) / 100;
    if (newMax > 0.95) { skipped.push(`${tierName}: would exceed 0.95, skipping`); continue; }

    // Find the line in the source that declares this tier's max.
    // Pattern: `tier <name> { max: <number> -> <model> }`
    const tierPattern = new RegExp(
      `(tier\\s+${tierName}\\s*\\{\\s*max:\\s*)(\\d+(?:\\.\\d+)?)(\\s*->)`,
    );
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const lineMatch = lines[i].match(tierPattern);
      if (lineMatch) {
        const oldVal = parseFloat(lineMatch[2]);
        if (Math.abs(oldVal - tierIR.max) > 0.001) continue; // wrong tier instance (defensive)
        lines[i] = lines[i].replace(tierPattern, `$1${newMax}$3`);
        applied.push({
          tier: tierName,
          oldMax: tierIR.max,
          newMax,
          line: i + 1,
          reason: suggestion,
        });
        modified = true;
        found = true;
        break;
      }
    }
    if (!found) skipped.push(`${tierName}: couldn't find max line in source`);
  }

  if (modified) {
    // Write backup.
    const backup = specPath + ".bak";
    fs.writeFileSync(backup, source, "utf-8");
    fs.writeFileSync(specPath, lines.join("\n"), "utf-8");
  }

  return { applied, skipped, written: modified };
}
