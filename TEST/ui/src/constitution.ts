// Project-level constitution — borrowed from spec-kit's /speckit.constitution.
// These are immutable rules the user wants applied to every forge run. They
// get appended to the description when the forge fires, so the LLM sees them
// in every prompt (analyze, scope, generate, repair).
//
// Two flavours of rule:
//   - Custom rules: free-text strings the user types in
//   - Preset rules: pre-built toggles for common constraints. The user just
//     ticks the boxes; we expand to the actual rule text when sending.
//
// Storage: localStorage key `marrowforge_constitution`. Single object,
// single key, < 1 KB.

const STORAGE_KEY = "marrowforge_constitution";

export interface Constitution {
  customRules: string[];
  presetFlags: Record<string, boolean>;
}

export const PRESET_RULES: Array<{ id: string; label: string; rule: string }> = [
  {
    id: "no_external_deps",
    label: "Use Node builtins only",
    rule: "Use ONLY Node.js builtin modules (fs, path, crypto, child_process, http, https, os, url, events, stream, util). Do not import any npm package.",
  },
  {
    id: "require_jsdoc",
    label: "Require JSDoc on exported symbols",
    rule: "Every exported symbol must have a JSDoc block explaining what it does and any non-obvious assumptions.",
  },
  {
    id: "max_file_lines",
    label: "Max 400 lines per file",
    rule: "Keep the generated file under 400 lines. If the work exceeds that, focus on the most central piece and add a TODO comment for the rest.",
  },
  {
    id: "strict_types",
    label: "Strict types — no 'any'",
    rule: "Do not use the 'any' type. Use 'unknown' with explicit narrowing where types are uncertain. Prefer named interfaces over inline shapes.",
  },
  {
    id: "no_console_log",
    label: "No console.log in shipping code",
    rule: "Do not use console.log for production code paths. Use a logger interface or document why a log is intentional.",
  },
  {
    id: "include_error_handling",
    label: "Include error handling",
    rule: "Every async operation and every external call must have explicit error handling. Don't let promises reject silently.",
  },
];

const DEFAULT: Constitution = {
  customRules: [],
  presetFlags: {},
};

export function loadConstitution(): Constitution {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<Constitution>;
    return {
      customRules: Array.isArray(parsed.customRules) ? parsed.customRules.map(String) : [],
      presetFlags: parsed.presetFlags && typeof parsed.presetFlags === "object" ? parsed.presetFlags : {},
    };
  } catch (e) {
    console.warn("[marrowforge] constitution load failed, using default:", e);
    return DEFAULT;
  }
}

export function saveConstitution(c: Constitution): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch (e) {
    console.warn("[marrowforge] constitution save failed:", e);
  }
}

/** Render the constitution as plain-text rule list the LLM will see. */
export function renderConstitutionForPrompt(c: Constitution): string {
  const lines: string[] = [];
  for (const preset of PRESET_RULES) {
    if (c.presetFlags[preset.id]) lines.push("- " + preset.rule);
  }
  for (const custom of c.customRules) {
    if (custom.trim()) lines.push("- " + custom.trim());
  }
  return lines.join("\n");
}

/** Compose the user's description with the constitution rules so the LLM
 *  sees the rules as part of every forge request. Returns the original
 *  description when no rules are active. */
export function applyConstitutionToDescription(description: string, c: Constitution): string {
  const rendered = renderConstitutionForPrompt(c);
  if (!rendered) return description;
  return description.trim() + "\n\nProject constitution (apply to every part of the artifact):\n" + rendered;
}

/** Count how many rules are currently active — used for the sidebar badge. */
export function countActiveRules(c: Constitution): number {
  return c.customRules.filter((r) => r.trim()).length +
         Object.values(c.presetFlags).filter(Boolean).length;
}
