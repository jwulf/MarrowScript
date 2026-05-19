/**
 * MarrowForge — recommended starter content for the two extension points.
 *
 * After running `marrowc compile marrowforge.marrow`, open
 *   output/src/extensions.ts
 * and replace the bodies inside the sentinel-bracketed regions with the
 * functions below. Sentinels look like this:
 *
 *   // <marrowscript:ext:tmpl_analyze:begin>
 *   ...your body here...
 *   // <marrowscript:ext:tmpl_analyze:end>
 *
 * Future `marrowc compile` runs preserve everything between the sentinels,
 * so prompt wording stays in your hands.
 *
 * The bodies below are deliberate, opinionated prompts:
 *   - tmpl_analyze targets the Tiny model (LM Studio, ~4B). It uses a JSON-
 *     only response shape so validate: schema_only succeeds. The complexity
 *     score is critical — it's what the router uses to pick Tiny vs Medium.
 *   - tmpl_generate targets either Tiny (cheap kinds: refactor / test /
 *     diagram) or Medium (component / endpoint / schema / full_feature) per
 *     the forge_router. It returns *only* a TypeScript code block so
 *     validate: ast_compiles can parse it.
 *
 * No prompt engineering exotica — just clear instructions, a fixed output
 * shape, and one example to anchor the format.
 */

// ─── tmpl_analyze ──────────────────────────────────────────────────────────
//
// Replace the body between the sentinels in src/extensions.ts with this:

export function tmpl_analyze(
  title: string,
  description: string,
  desired_kind: string,
  target_path: string,
): string {
  return [
    "You are MarrowForge's analyst. Read the request below and return ONLY a",
    "JSON object on a single line. No prose, no code fences, no explanation.",
    "",
    "The JSON object MUST have exactly these keys, all required:",
    "  kind          — one of: component, endpoint, schema, refactor, diagram, full_feature, test",
    "  summary       — one short sentence (≤ 140 chars) describing what to build",
    "  plan          — 3 to 6 numbered steps describing the implementation, joined with \\n",
    "  target_symbol — the primary symbol name the artifact will define (PascalCase, ≤ 64 chars)",
    "  complexity    — a number in [0.0, 1.0] estimating how much capability is required:",
    "                  0.0 = trivial change, 0.5 = a focused new module, 1.0 = a multi-file feature",
    "",
    "Estimate complexity by these signals:",
    "  - simple refactor / one-file change           → 0.05 .. 0.25",
    "  - new endpoint / new schema / new component   → 0.25 .. 0.55",
    "  - cross-cutting feature spanning ≥ 3 files    → 0.55 .. 0.85",
    "  - architecture change / migration / planning  → 0.85 .. 1.00",
    "",
    "Example output (single line, exact shape):",
    "{\"kind\":\"endpoint\",\"summary\":\"REST GET /users/:id returning the user record\",\"plan\":\"1. Add Express route\\n2. Wire query param to db.query\\n3. Return 404 on miss\",\"target_symbol\":\"GetUserHandler\",\"complexity\":0.35}",
    "",
    "Request:",
    `  title:        ${title}`,
    `  description:  ${description}`,
    `  desired_kind: ${desired_kind}`,
    `  target_path:  ${target_path}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

// ─── tmpl_generate ─────────────────────────────────────────────────────────
//
// Replace the body between the sentinels in src/extensions.ts with this:

export function tmpl_generate(
  plan: string,
  target_symbol: string,
  files: string,
  desired_kind: string,
  target_path: string,
  description: string,
): string {
  // `plan` arrives as either the raw JSON string from analyze_forge_request
  // or the parsed object stringified — try to extract the human-readable
  // plan text either way without crashing.
  let planText = plan;
  try {
    const parsed = typeof plan === "string" ? JSON.parse(plan) : plan;
    if (parsed && typeof parsed === "object" && typeof parsed.plan === "string") {
      planText = parsed.plan;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.summary === "string") {
      planText = `${parsed.summary}\n${parsed.plan ?? ""}`;
    }
  } catch {
    // Not JSON — assume `plan` is already plain text.
  }

  // `files` comes from semantic_slice. It's either the structured slice
  // object (from runCognition) or a JSON-stringified version of it.
  let sliceText = "(no relevant files)";
  try {
    const parsed = typeof files === "string" ? JSON.parse(files) : files;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).files)) {
      const list = (parsed as { files: string[]; symbols?: string[] }).files;
      if (list.length > 0) {
        sliceText = list.slice(0, 8).map((f) => `  - ${f}`).join("\n");
      }
    }
  } catch {
    if (typeof files === "string" && files.length > 0) {
      sliceText = files.slice(0, 2000);
    }
  }

  return [
    "You are MarrowForge's generator. Produce ONLY a TypeScript code block",
    "that implements the request below. No prose, no markdown headers, no",
    "explanation. Every line must be valid TypeScript that the project's",
    "tsc --noEmit pass would accept under strict mode.",
    "",
    "Rules:",
    "  - Wrap output in a single ```typescript ... ``` fence so the runtime",
    "    can extract it. Nothing else outside the fence.",
    "  - Define the symbol exactly as `target_symbol` says (export it).",
    "  - Use only standard Node.js libraries unless the existing files in",
    "    the slice clearly establish a dependency to reuse.",
    "  - Add JSDoc on the exported symbol explaining what it does.",
    "  - Prefer narrow, named types over `any`. If you need a union, write",
    "    it out — never reach for `unknown` to dodge the type system.",
    "",
    `Desired kind:    ${desired_kind}`,
    `Target path:     ${target_path}`,
    `Target symbol:   ${target_symbol || "(pick a sensible PascalCase name from the description)"}`,
    "",
    "Plan:",
    planText,
    "",
    "Relevant existing files (read-only context — do NOT regenerate them):",
    sliceText,
    "",
    "Original request:",
    description,
    "",
    "Now return the TypeScript code block.",
  ].join("\n");
}

// ─── Optional: assemble + save the result ───────────────────────────────────
//
// The pipeline produces __pipeline_results = { analysis, slice, artifact }.
// You'll typically want a small adapter that turns those three values into
// a typed ForgeResult row and inserts it via the generated ForgeResultStore.
// This adapter is NOT a MarrowScript construct — it's plain Node.js. Drop it
// alongside the extension functions in src/extensions.ts (outside the
// sentinels, near the top of the file) so it's available to your handler.

export interface ForgeResultRow {
  request_id: string;
  kind: string;
  summary: string;
  target_path: string;
  target_symbol: string;
  artifact: string;
  plan: string;
  confidence: number;
  ast_compiles: boolean;
  tier_used: string;
  trace_id: string;
}

export function assembleForgeResult(
  request_id: string,
  trace_id: string,
  analysis: unknown,
  artifact: unknown,
): ForgeResultRow {
  // Default-safe assembly. Anything missing from the model output falls back
  // to a neutral default — we never throw here.
  let kind = "component";
  let summary = "";
  let plan = "";
  let target_symbol = "";
  let confidence = 0.0;

  if (typeof analysis === "string") {
    try {
      const parsed = JSON.parse(analysis) as Record<string, unknown>;
      if (typeof parsed.kind === "string") kind = parsed.kind;
      if (typeof parsed.summary === "string") summary = parsed.summary;
      if (typeof parsed.plan === "string") plan = parsed.plan;
      if (typeof parsed.target_symbol === "string") target_symbol = parsed.target_symbol;
      if (typeof parsed.complexity === "number") confidence = clamp01(1 - parsed.complexity * 0.3);
    } catch {
      summary = analysis.slice(0, 140);
    }
  }

  const code = typeof artifact === "string" ? extractCodeFence(artifact) : "";

  return {
    request_id,
    kind,
    summary,
    target_path: "",
    target_symbol,
    artifact: code,
    plan,
    confidence,
    ast_compiles: code.length > 0,
    tier_used: "auto",
    trace_id,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function extractCodeFence(text: string): string {
  // Pull the first ```typescript ... ``` (or any language) block.
  const match = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  return text.trim();
}
