/**
 * MarrowScript Promptbook (LLM Harness, Phase 18)
 *
 * Closed registry of typed, baseline prompt templates. The user references
 * an entry via `promptbook: <name>` inside a `prompt {...}` body and supplies
 * parameters via `with: { ... }`. Each entry has:
 *
 *   - a parameter spec (closed list of arg names + types)
 *   - a baseline `template` string with {{param}} placeholders
 *   - documentation (cost/latency hints)
 *
 * The compiler renders the template by substituting parameters at compile
 * time so the runtime sees a plain string template. There is no runtime
 * dependency on this file — the rendering happens in lowering.
 *
 * Adding a new entry: append to PROMPTBOOK below, document the parameter
 * shape, and write a baseline test in test_cognition_phase18.ts. Each entry
 * is a one-shot text completion; multi-turn / agent shapes belong elsewhere.
 *
 * Determinism: PROMPTBOOK is a frozen map keyed by stable names. The
 * rendering substitutes literals only — no Date.now()/Math.random().
 */

export interface PromptbookParam {
  name: string;
  /** Param type as it appears in the user's `with:` clause. */
  type: "string" | "string[]" | "uint" | "float";
  required: boolean;
  description: string;
}

export interface PromptbookEntry {
  name: string;
  category: "classification" | "extraction" | "generation" | "validation" | "reasoning";
  description: string;
  params: PromptbookParam[];
  /**
   * Baseline template. Uses `{{param}}` for promptbook-arg substitution and
   * `{{__input.<name>}}` for the prompt's own input parameters (these are
   * NOT substituted at compile time; the runtime emitter wires them).
   */
  template: string;
  /**
   * Recommended return type expression. Users can override but the type
   * checker emits a hint when the override doesn't match.
   */
  recommended_return: string;
  /** Recommended validation mode. */
  recommended_validate: "schema_only" | "ast_compiles" | "none";
}

export const PROMPTBOOK: Record<string, PromptbookEntry> = {
  // ── Classification ────────────────────────────────────────────────────────
  binary_classify: {
    name: "binary_classify",
    category: "classification",
    description: "Yes/no labeling of a single text input. Output is one of two declared labels.",
    params: [
      { name: "positive_label", type: "string", required: true, description: "Label returned for matches (e.g. 'spam')" },
      { name: "negative_label", type: "string", required: true, description: "Label returned for non-matches (e.g. 'ham')" },
    ],
    template:
      "You are a strict binary classifier.\n" +
      "Decide whether the following text matches the criterion.\n" +
      "Respond with EXACTLY one of these two labels and nothing else:\n" +
      "  - {{positive_label}}\n" +
      "  - {{negative_label}}\n" +
      "\n" +
      "Text:\n" +
      "{{__input.text}}",
    recommended_return: "string",
    recommended_validate: "schema_only",
  },

  multi_class_classify: {
    name: "multi_class_classify",
    category: "classification",
    description: "Single-label classification from a closed list of categories.",
    params: [
      { name: "categories", type: "string[]", required: true, description: "Closed list of allowed labels" },
    ],
    template:
      "You are a strict multi-class classifier.\n" +
      "Pick exactly one label from this list:\n" +
      "{{categories}}\n" +
      "\n" +
      "Respond with the label only — no quotes, no extra words.\n" +
      "\n" +
      "Text:\n" +
      "{{__input.text}}",
    recommended_return: "string",
    recommended_validate: "schema_only",
  },

  // ── Generation ────────────────────────────────────────────────────────────
  summarize: {
    name: "summarize",
    category: "generation",
    description: "Compress prose into a shorter form preserving key facts.",
    params: [
      { name: "max_words", type: "uint", required: false, description: "Target length cap (default 80)" },
      { name: "style", type: "string", required: false, description: "Style hint: 'bullets' | 'paragraph' | 'one-liner'" },
    ],
    template:
      "Summarise the following text. Be faithful: do not add information that isn't present.\n" +
      "Style: {{style}}\n" +
      "Maximum length: {{max_words}} words.\n" +
      "\n" +
      "Text:\n" +
      "{{__input.text}}\n" +
      "\n" +
      "Summary:",
    recommended_return: "string",
    recommended_validate: "schema_only",
  },

  paraphrase: {
    name: "paraphrase",
    category: "generation",
    description: "Restate text preserving meaning. Useful for tone-shifting or simplification.",
    params: [
      { name: "tone", type: "string", required: false, description: "Tone hint (e.g. 'professional', 'casual')" },
    ],
    template:
      "Rewrite the following text in your own words. Preserve every fact and nuance.\n" +
      "Target tone: {{tone}}\n" +
      "\n" +
      "Original:\n" +
      "{{__input.text}}\n" +
      "\n" +
      "Rewritten:",
    recommended_return: "string",
    recommended_validate: "schema_only",
  },

  translate: {
    name: "translate",
    category: "generation",
    description: "Translate between languages. Output is the translated text only.",
    params: [
      { name: "target_language", type: "string", required: true, description: "Target language (e.g. 'Spanish', 'Japanese')" },
    ],
    template:
      "Translate the following text into {{target_language}}.\n" +
      "Output only the translation. Do not include the source.\n" +
      "\n" +
      "Source:\n" +
      "{{__input.text}}\n" +
      "\n" +
      "Translation:",
    recommended_return: "string",
    recommended_validate: "schema_only",
  },

  // ── Extraction ────────────────────────────────────────────────────────────
  extract_json: {
    name: "extract_json",
    category: "extraction",
    description: "Pull a typed JSON shape from prose. The user supplies the schema as a description.",
    params: [
      { name: "schema_description", type: "string", required: true, description: "Plain-English description of the desired JSON shape" },
    ],
    template:
      "Extract the following information from the text below as a JSON object.\n" +
      "Schema:\n" +
      "{{schema_description}}\n" +
      "\n" +
      "Output valid JSON only. No prose, no markdown fences, no explanation.\n" +
      "\n" +
      "Text:\n" +
      "{{__input.text}}",
    recommended_return: "json",
    recommended_validate: "schema_only",
  },

  // ── Reasoning ─────────────────────────────────────────────────────────────
  chain_of_thought_solve: {
    name: "chain_of_thought_solve",
    category: "reasoning",
    description: "Step-by-step problem solving. The model thinks aloud, then commits to a final answer.",
    params: [
      { name: "domain", type: "string", required: false, description: "Problem domain hint (e.g. 'math', 'logic', 'planning')" },
    ],
    template:
      "Solve the following {{domain}} problem step by step.\n" +
      "First, work through your reasoning. Then on the final line, write:\n" +
      "  ANSWER: <your final answer>\n" +
      "\n" +
      "Problem:\n" +
      "{{__input.problem}}",
    recommended_return: "string",
    recommended_validate: "schema_only",
  },

  self_critique_then_revise: {
    name: "self_critique_then_revise",
    category: "reasoning",
    description: "Two-pass quality check: produce a draft, critique it, then revise. Output is the revised version.",
    params: [
      { name: "criteria", type: "string", required: true, description: "What to critique (e.g. 'factual accuracy', 'clarity', 'tone')" },
    ],
    template:
      "You will improve the following draft via self-critique.\n" +
      "Step 1: Identify weaknesses against this criterion: {{criteria}}\n" +
      "Step 2: Rewrite to fix the weaknesses.\n" +
      "Output the revised version only. Do not include the critique.\n" +
      "\n" +
      "Draft:\n" +
      "{{__input.draft}}",
    recommended_return: "string",
    recommended_validate: "schema_only",
  },
};

/**
 * Render a promptbook entry with the given args + input param names. Returns
 * the template string with promptbook-arg placeholders substituted (literal
 * `{{param}}` → arg value) and `{{__input.<name>}}` placeholders left intact
 * (the cognition emitter wires them at runtime).
 *
 * Defaults: when a non-required param is missing, the placeholder is replaced
 * with an empty string. The runtime tolerates trailing whitespace gracefully.
 */
export function renderPromptbookTemplate(
  entry: PromptbookEntry,
  args: Record<string, string | number | string[]>,
): string {
  let out = entry.template;
  for (const p of entry.params) {
    const val = args[p.name];
    let str: string;
    if (val === undefined || val === null) {
      str = "";
    } else if (Array.isArray(val)) {
      // Render string[] as a bullet list.
      str = (val as string[]).map(s => "  - " + s).join("\n");
    } else {
      str = String(val);
    }
    // Replace every {{name}} occurrence. The placeholder syntax doesn't
    // escape regex specials in user-provided values — we plug the value as
    // a literal string, not as a regex pattern.
    out = out.split(`{{${p.name}}}`).join(str);
  }
  return out;
}

/** Look up an entry by name. Returns null when not found. */
export function lookupPromptbookEntry(name: string): PromptbookEntry | null {
  return PROMPTBOOK[name] ?? null;
}

/** List all promptbook names sorted alphabetically. Used by the LSP / docs. */
export function listPromptbookNames(): string[] {
  return Object.keys(PROMPTBOOK).sort();
}
