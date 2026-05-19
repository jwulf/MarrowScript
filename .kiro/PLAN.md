# MarrowScript — Lean Into The LLM Angle

A roadmap for the next phase of MarrowScript. Existing phases 1-13 already shipped a deterministic compiler with a working LLM cognition layer (typed prompts, routers, validators, repair, traces, fallback escalation, scoping pass). This plan picks up from there and pushes the language further into territory no other system covers cleanly: **deterministic, typed, eval-driven LLM orchestration as a first-class language primitive**.

The thesis: every other LLM framework is a Python library you bolt onto an app. MarrowScript is the only system where LLM cognition is a compile-time concern with the same rigor as a SQL schema. The work below leans into that uniqueness instead of trying to compete with general-purpose code generators.

---

## Why this direction

The competitive landscape, honestly:

| Tool | What it is | What it lacks |
|---|---|---|
| LangChain / LlamaIndex | Python LLM glue libraries | No determinism, no compile-time validation, no codegen |
| spec-kit | Workflow + slash commands inside an IDE | No runtime; produces source files, then disappears |
| Pulumi / CDK | Infrastructure as code | Knows nothing about LLMs |
| Encore / Wasp / RedwoodSDK | Backend-as-code generators | No LLM cognition primitives |
| OpenAI Assistants / function calling | Agent runtime | Not deterministic, not local, not yours |
| Promptfoo / OpenAI Evals | Eval frameworks | Separate tool, requires hand-wired integration |
| Inngest / Temporal | Workflow engines | LLM-agnostic; no typed prompt contracts |

**MarrowScript already covers parts of every column.** It compiles to a real backend like Encore, has typed prompts like LangChain wishes it did, runs locally like Ollama, generates code like spec-kit. The unique slice nobody else owns: **LLM operations are a deterministic compile-time artifact, the runtime is generated for them, and the whole thing is one source-of-truth file**.

The plan below leans on that. Each phase makes the language more LLM-native without abandoning determinism.

---

## Phase 14 — Multi-file artifact output ✅ DELIVERED

**Why first:** Single-file output is the biggest practical limitation. Every "real" project (browser extensions, monorepos, multi-module backends) needs more than one file. Without this, MarrowForge stays stuck producing single-file adapters.

### Surface

```marrow
prompt generate_module(spec: string) {
  router: forge_router
  template: "extension_point:tmpl_generate_module"
  returns: list<File>          // new shape
  validate: ast_compiles_per_file
  on_invalid: retry_with_repair_prompt
}
```

`File` is a built-in primitive shape:
```
File { path: string, content: string, kind: "ts" | "tsx" | "json" | "md" | "yaml" }
```

### What changes

- **AST/IR**: new `IRTypeFile` and `IRReturnList<File>`.
- **Validator**: extends `ast_compiles` to walk a list and validate each file in isolation, then run a second pass with a synthetic project root so cross-file imports (`./other.ts`) resolve. New `ast_compiles_per_file` mode handles unresolved imports across the file set.
- **Emitter**: prompt body parses the model's output as JSON-array-of-File records, fence-extracts each `content` field, validates per-file, returns the array.
- **Repair prompt**: receives the issue list **per file** so it knows which file to fix.
- **Pipeline emitter**: when a downstream step takes a single string, accept the largest entry by default (legacy behavior); when it takes `list<File>`, pass through unchanged.

### Determinism

- File order in the output array is **stable** — sorted alphabetically by path before validation and before write.
- The model is instructed to emit files in alphabetical path order; the emitter resorts defensively.
- Each file's hash is recorded in the trace span so re-runs can compare.

### Risk

The model produces inconsistent file shapes (mixes JSON and markdown, forgets the `kind` field, writes a single file when asked for many). Mitigation: a strict Zod schema on the array, a repair prompt with concrete examples, and a soft-fallback that treats unparseable output as a single-file artifact targeting the requested `target_path`.

### Effort

3-5 days. Highest ROI feature in the entire plan because every later phase depends on it.

---

## Phase 15 — Bounded tool calls (`tools:` becomes real) ✅ DELIVERED

**Why:** The `tools:` clause exists on the IR today but doesn't actually enable function calling. The cognition layer treats prompts as one-shots. Adding real tool calls turns prompts into bounded agent loops without giving up determinism.

### Surface

```marrow
prompt classify_with_lookup(question: string) {
  model: Tiny
  template: "extension_point:tmpl_classify_with_lookup"
  returns: { category: string, confidence: float }
  tools: [search_docs, check_npm_package]
  max_tool_calls: 5
  validate: schema_only
}

capability search_docs(query: string) {
  cognition: vector_retrieve using { ... }
  returns: list<{ title: string, body: string }>
}
```

### Constraints (this is the determinism story)

- The tool list is **closed and compile-time-resolved** — type checker error if a tool isn't a declared capability.
- Each tool call emits a span with input/output redacted per `@sensitive` rules.
- `max_tool_calls` is enforced at the runtime; exceeding it throws `ToolCallBudgetExceeded`.
- The whole loop is **bounded** — no recursion, no LLM-driven tool registration, no dynamic dispatch.
- Tool inputs and outputs are validated against the called capability's typed contract; the LLM can't pass arbitrary JSON.

### What changes

- **emit_provider.ts**: openai_compat / llamacpp / ollama adapters get function-calling parameters added to the chat request.
- **emit_cognition.ts**: prompt body adds a tool-call loop that:
  1. Sends initial messages + tool schemas
  2. Receives `{ tool_calls: [...] }`
  3. For each call: validate inputs → invoke the capability → push result back → re-prompt
  4. Repeat until model returns a final answer or budget is exhausted
- **Tracing**: each tool call is a child span of the prompt span (`kind: "tool_call"`).

### Determinism

- The order of tool calls is recorded in the trace.
- Tool replay (via `marrowc replay`) feeds recorded outputs to the model in the same order.
- Tool capabilities themselves are deterministic when their bodies are (algorithmic) or stochastic in well-defined ways (HTTP retries with jitter).

### Effort

5-7 days. Hardest part is the protocol differences between providers (OpenAI's function calling, llama.cpp's grammar mode, Ollama's structured output). Solved before; just needs the harness wiring.

---

## Phase 16 — `evaluation` primitive ✅ DELIVERED

**Why:** Once a prompt is in production, you need to know when a "small tweak" breaks it. Promptfoo and OpenAI Evals exist as separate tools; baking eval into the language closes the loop. This is the hidden killer feature — every team running production prompts wants this and most cobble it together with shell scripts.

### Surface

```marrow
evaluation generate_forge_artifact_quality {
  prompt: generate_forge_artifact

  cases: [
    {
      name: "simple_compat_layer"
      input: { description: "...", preset: "compat_layer", complexity: 0.65 }
      expected: {
        passes: ast_compiles
        contains_class_named: matches("^[A-Z][a-zA-Z]+Adapter$")
        max_lines: 400
      }
    }
    {
      name: "needs_external_packages"
      input: { description: "Adapter using react-query", complexity: 0.7 }
      expected: {
        passes: ast_compiles
        imports_only_from: ["@tanstack/react-query", "react"]
      }
    }
  ]

  metric: weighted_pass_rate { ast_compiles: 0.5, contains: 0.3, max_lines: 0.2 }
  baseline: { ref: "main", min_pass_rate: 0.85 }

  schedule: { on: ["pre_commit", "ci_pr"] }
}
```

### What changes

- New top-level decl `evaluation` in lexer/AST/parser/IR/lowering/typechecker.
- New emitter `emit_evaluation.ts`:
  - Generates `eval/<name>.ts` with the case fixtures embedded
  - Generates a CLI subcommand `marrowc evaluate <name>` that runs the cases, compares to baseline, prints a delta table, exits non-zero on regression
  - Generates a CI workflow snippet that runs `marrowc evaluate --all` on PRs
- Trace-aware: each case execution writes to `cognition_traces` with `evaluation_run_id` for later analysis.
- Reproducibility: cases bind a deterministic seed per prompt invocation so retries are stable.

### Built-in expectation operators

- `passes: ast_compiles | schema_only | custom:<ext>`
- `contains_class_named: matches(<regex>)`
- `imports_only_from: list<string>`
- `max_lines: number`
- `min_lines: number`
- `must_contain_string: list<string>` (every entry must appear)
- `must_not_contain_string: list<string>` (none may appear)
- `latency_under_ms: number`
- `cost_under_usd: number`
- `custom: extension_point` for domain-specific checks

### Determinism

- Eval runs are **deterministic when the same model is used** because the cognition layer pins temperature, top_p, and seed.
- Baseline comparison stores the previous eval result hashed with `(prompt_template_hash, model_id)`. Different model = different baseline; the eval refuses to compare across models.
- The CI integration produces a comment on the PR with a delta table — same shape as code-coverage tools.

### Effort

5-7 days. Eval primitive itself is small (~2 days); CLI + CI integration + the diff/baseline machinery is the bulk.

---

## Phase 17 — `flow.checkpoint` + `flow.review` ✅ DELIVERED

**Why:** Spec-kit's biggest UX win is human-in-the-loop checkpoints between stages. MarrowScript flows currently run end-to-end; adding a pause primitive turns them into reviewable workflows without bolting on a separate workflow engine.

### Surface

```marrow
flow patch_review_workflow {
  step generate: run_patch(t) as p
    checkpoint: review_plan {
      shows: [p.plan, p.target_symbol, p.complexity]
      allow: ["approve", "edit", "regenerate", "reject"]
      timeout: 24h on_timeout: cancel
    }

  step apply: save_patch(p)
    compensate: rollback_patch(p)
}
```

### What changes

- New `checkpoint` step modifier in flow grammar.
- A `flow_runs` table in the migration set with state: `running | paused | resumed | completed | cancelled`.
- A `POST /flow_runs/:id/checkpoint/:name` endpoint that takes the user's decision and either resumes the flow or cancels it.
- A `GET /flow_runs/:id` endpoint that returns the current state including any pending checkpoint with its `shows` payload.
- Generated React hooks: `useFlowCheckpoint(flowRunId, checkpointName)` returns `{ pending, payload, approve, edit, regenerate, reject }`.

### Why this is the LLM angle

Today, "human reviews LLM output" lives in the UI as a one-off. Making it a language primitive means every system gets the same checkpoint-with-traceable-decision pattern. Audit trails, decision history, who-approved-what are all generated for free.

### Determinism

- Each checkpoint decision is recorded in `flow_run_checkpoints` with actor_id, decision, timestamp, edited payload.
- Replay is supported: a flow can be re-run with a recorded decision sequence.
- Timeouts use the existing cron infrastructure — no new scheduler needed.

### Effort

3-5 days. State machine, persistence, and UI hooks are the bulk. Architecture mirrors existing `flow` runtime; this is an extension, not a rewrite.

---

## Phase 18 — Promptbook (typed prompt library) ✅ DELIVERED

**Why:** Every team writes the same prompts (classification, summarization, structured extraction). Right now every project re-invents `tmpl_classify`, `tmpl_summarize`, `tmpl_extract`. A typed standard library of prompts is the LLM-equivalent of having `Math.floor` instead of writing your own floor function every project.

### Surface

```marrow
import promptbook.classification.binary_classify
import promptbook.extraction.structured_extract<T>

system MyApp {
  prompt is_spam(text: string) = promptbook.binary_classify with {
    positive_label: "spam"
    negative_label: "ham"
    confidence_threshold: 0.7
  }

  prompt extract_invoice(pdf_text: string) = promptbook.structured_extract<Invoice> with {
    schema: Invoice
    require_fields: ["amount", "vendor", "date"]
  }
}
```

### Initial library

| Category | Primitives |
|---|---|
| Classification | `binary_classify`, `multi_class_classify`, `intent_detect`, `sentiment_score` |
| Extraction | `structured_extract<T>`, `entities_extract`, `key_value_extract` |
| Generation | `summarize`, `paraphrase`, `expand_outline`, `translate`, `format_as_<style>` |
| Validation | `is_factual_against`, `passes_policy`, `matches_schema` |
| Reasoning | `chain_of_thought_solve`, `self_critique_then_revise`, `decompose_into_subtasks` |
| Code | `explain_code`, `generate_test_for`, `refactor_with_intent`, `find_bugs` |

Each entry ships with:
- A typed contract (input shape, return shape, cost class, validation mode)
- A baseline prompt template living in MarrowScript's source tree
- A baseline eval (Phase 16) that ensures the template still works when MarrowScript itself updates
- Provider-specific tweaks (OpenAI vs Anthropic vs local llama have different optimal phrasings)

### What changes

- New `import` statement in lexer/parser (currently has a placeholder; make it real).
- A `promptbook/` directory in the compiler distribution with the standard library.
- The type checker resolves `promptbook.foo` against a registry the compiler ships with.
- A user can override any promptbook entry locally without forking — same `extension_point` mechanism that already exists.

### Effort

7-10 days. The library itself is the work; each entry is small but there are 20+ to write and eval-baseline.

---

## Phase 19 — Cost-aware routing ✅ DELIVERED

**Why:** Today's router routes by `input.complexity` — a single user-supplied number. Real systems want to route by **observed cost-quality trade-off**. "Use the cheap model when it works, escalate to the expensive one when it doesn't, learn which prompts need which from history."

### Surface

```marrow
router forge_router {
  by: dynamic
  observe: ["latency_p50", "validation_pass_rate", "cost_usd_per_call"]

  tier fast   { -> Tiny }
  tier strong { -> Medium }

  policy: minimize_cost_subject_to {
    validation_pass_rate >= 0.9
    latency_p95 <= 30s
  }

  fallback: Medium
}
```

### What changes

- Router emits a learned routing function based on observed traces.
- `marrowc compile` reads the last N runs from `cognition_traces` (locally or from a connected PG instance) and computes per-tier success rates.
- The generated router is still deterministic at runtime — it consults a static decision table emitted at compile time. The "learning" happens at compile time, not at request time.
- A new CLI subcommand `marrowc tune-router <name>` re-runs the analysis and updates the embedded decision table.

### Determinism preserved

- The router's runtime behavior is fully deterministic (same input → same tier).
- The "learning" is offline. Re-running `tune-router` against the same data produces the same decision table.
- Audit trails record which decision-table-version was used for each call.

### Effort

5-7 days. The hard part is the optimization formulation; the rest is plumbing.

---

## Phase 20 — Bidirectional code-spec sync ✅ DELIVERED (v1: AST-only)

**Why:** Right now the spec generates code one-way. The deepest spec-kit idea is the inverse: code that drifts from spec gets flagged, and the spec can be updated from code annotations. This is the single biggest blocker for MarrowScript adoption in **existing codebases**.

**v1 ships static-analysis foundation; v2 ships LLM-driven capability inference.**

### Surface

A new CLI:

```bash
marrowc reflect ./src/payments
```

Reads existing TypeScript, infers the `.marrow` declarations that would have produced it, and produces:

```marrow
// inferred from src/payments — review before merging
system Payments {
  entity Order {
    owns: [
      id: uuid
      buyer_id: uuid
      total_cents: int
      status: string
    ]
    states: pending -> paid -> shipped | refunded
  }

  capability create_order(buyer_id: uuid, items: list<Item>) { ... }
}
```

And a complementary command:

```bash
marrowc diff payments.marrow ./src/payments
```

Shows what's changed between spec and code, highlighting drift.

### Why this is LLM-leveraged

This is **only realistic with an LLM**. Static analysis can recover entity shapes and CRUD endpoints, but inferring intent (state machines, retries, audit boundaries, capability semantics) requires semantic understanding. Use the cognition layer to do it:

```marrow
// inside the compiler, not the user's project
prompt infer_marrow_from_typescript(files: list<File>) {
  router: marrowc_router
  returns: string  // the inferred .marrow source
  validate: schema_only
  tools: [
    list_directory,
    read_file,
    find_function,
    find_class,
  ]
  max_tool_calls: 50
}
```

The LLM walks the codebase via tool calls, builds a model in its head, emits the spec. The user reviews and merges.

### Determinism

This phase **explicitly accepts non-determinism** — but only at the inference boundary. The output `.marrow` is then deterministic forever after. The trade-off is honest: you're using an LLM as a one-time port-from-existing-code helper, not as a runtime decision-maker.

### Effort

10-14 days. This is a real feature, not a sketch. The LLM driving needs a careful prompt + tool-call loop, the diff machinery needs to handle structural comparisons (entity additions, field renames), and the user review UX needs thought.

### Why this matters most for adoption

Every other phase improves what MarrowScript can build. **This phase makes MarrowScript adoptable in projects that already exist.** That's the single biggest barrier to using it on real work today, and it's the feature that compounds the value of every previous phase by making them available to every existing TypeScript codebase, not just greenfield ones.

---

## Phase 21 — `cost_budget` and `quota` as first-class policy ✅ DELIVERED

**Why:** Multi-tenant LLM systems need real quotas. `LLM_BUDGET_USD_PER_TRACE` is per-call. Production needs per-tenant, per-day, per-feature, per-user budgets with first-class enforcement.

### Surface

```marrow
policy app_costs {
  rate_limit: 60 per 1m
  audit: true

  cost_budgets: [
    {
      scope: per_tenant
      window: 1d
      cap_usd: 5.00
      on_exceeded: { action: throttle, retry_after: 1h }
    }
    {
      scope: per_user
      window: 1h
      cap_tokens: 100_000
      on_exceeded: { action: error, code: "DAILY_LIMIT" }
    }
    {
      scope: per_feature: "generate_forge_artifact"
      window: 1h
      cap_calls: 10
      on_exceeded: { action: queue, max_queue: 100 }
    }
  ]
}
```

### What changes

- Existing `policy` block extended with a `cost_budgets` clause.
- Generated `src/budgets.ts` with PG-backed counters, sliding windows, atomic increment-and-check.
- Pipeline emitter inserts a budget gate before any prompt call: `assertWithinBudget(scope, action) → throws or queues`.
- New tables: `budget_counters` (current usage), `budget_queue` (queued calls), `budget_events` (audit).
- Admin endpoints: `GET /admin/budgets/:tenant`, `POST /admin/budgets/:tenant/reset`.

### Effort

5-7 days. Conceptually straightforward; the queueing-with-fairness story is the hard part.

---

## Phase 22 — Replay-as-test ✅ DELIVERED

**Why:** Every cognition trace is a recording. Today `marrowc replay <trace_id>` re-runs a flow with recorded outputs. Make every trace a runnable test:

```bash
marrowc trace-to-test <trace_id> > test/regression_<trace_id>.test.ts
```

The result is a pinned regression test that:
- Mocks the cognition layer with the trace's recorded outputs
- Asserts the surrounding capability produced the expected effects
- Catches regressions when the surrounding code changes but the LLM behavior stays the same

### Why this is the LLM angle

Production LLM systems break in two ways: the model changes (drifts) or the surrounding code changes (regression). Replay-as-test catches the second category cheaply. Combined with Phase 16 evals (which catch the first), you have a complete "did anything break" pipeline that other LLM frameworks lack entirely.

### Effort

3-5 days. Most of the runtime exists already; this is just packaging it as a generator.

---

## Suggested order

If I were holding the decision pen:

1. **Phase 14 (multi-file output)** — unblocks everything else. 3-5 days. Highest leverage.
2. **Phase 15 (real `tools:`)** — the second-biggest LLM-angle differentiator. 5-7 days.
3. **Phase 16 (eval primitive)** — close the production loop. 5-7 days.
4. **Phase 17 (checkpoints)** — UX win, small effort. 3-5 days.
5. **Phase 22 (replay-as-test)** — natural follow-on to #16. 3-5 days.
6. **Phase 21 (cost budgets)** — production-readiness. 5-7 days.
7. **Phase 18 (promptbook)** — pleasant ergonomics. 7-10 days.
8. **Phase 19 (cost-aware routing)** — sophisticated, needs traffic to be useful. 5-7 days.
9. **Phase 20 (code-spec sync)** — the adoption unlock. 10-14 days. Save for last because it's the biggest and benefits from every preceding phase.

Total: ~6-10 weeks of focused work for the full set. The first three (Phases 14, 15, 16) are the inflection point — they turn MarrowScript from "interesting LLM-runtime-generator" into "the only typed deterministic LLM platform" and would each ship as a meaningful release on their own.

---

## What we're explicitly not building

To keep MarrowScript's identity sharp, these are out of scope:

- **Python or Go output.** Stay TypeScript-first. Multi-language is a distraction; depth in one language wins.
- **Generic agent frameworks.** No autonomous loops, no recursive self-prompting, no model-driven workflow mutation. Every loop must be a compile-time DAG.
- **A model marketplace or hosted runtime.** Stay infrastructure-as-code. Selling models is somebody else's business.
- **Visual workflow editors.** The .marrow file is the source of truth. Editors are downstream tools other people can build.
- **Mobile/native targets.** Web backend + edge runtime are the focus.
- **Direct integration with proprietary APIs.** Provider adapters stay generic; specific integrations live in user code or in published `@scope/marrow-*` packages.

Saying no to these is what makes the language coherent. Every phase above strengthens the core thesis — typed, deterministic, eval-driven LLM operations as a compile-time concern — instead of dragging the project sideways.

---

## Open questions

These should be settled before starting Phase 14:

1. **Multi-file repair scope.** When 3 files validate but 1 fails, do we repair only the failing file, or repair all of them with a holistic context? Probably file-scoped repair, but worth confirming with a few real cases.

2. **Promptbook governance.** The promptbook ships with the compiler as a compiled-in file (`compiler/src/promptbook.ts`). Every promptbook update is a compiler update. There is no separate package — this repo is private and will not be published to any public registry.

3. **Cost-aware routing data source.** Does `marrowc tune-router` read from local trace files (works for solo devs) or require a connected PG (works for teams)? Both, with the local file fallback being the default. But the schema differences are real.

4. **Code-spec sync verification.** When `marrowc reflect` infers a spec, how confident is it? Should the inferred spec carry confidence scores per declaration so the human reviewer knows which parts are trustworthy and which are guesses?

5. **Whether to ship Phase 20.** It's the biggest single lift in the plan. If we ship Phases 14-19 first and find that greenfield adoption is enough for the first wave of users, we might never need to do 20. Worth keeping as a "do if there's demand" rather than committing upfront.
