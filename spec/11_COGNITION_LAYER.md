# MarrowScript Specification — 11. Cognition Layer

This chapter specifies the MarrowScript LLM Harness — a model-agnostic deterministic orchestration layer for weak/small language models (1B–8B parameters, on-device or self-hosted). The cognition layer is **additive**: a `.marrow` file with no `model`, `prompt`, `router`, or `cognition:` modifier compiles exactly as it did pre-harness. Adding any of those constructs activates the harness emitters.

The guiding premise is the same as the rest of MarrowScript: **the compiler is bitwise deterministic; non-determinism is confined to model invocation and is wrapped in compensation, validation, retry, and tracing**.

---

## 11.1 New Top-Level Declarations

### 11.1.1 `model`

Declares a model adapter and its budget envelope. The compiler emits a typed registry entry; provider adapters live in `src/providers/`.

```marrow
model TinyClassifier {
  provider: ollama
  name: "qwen2.5-coder:1.5b"
  context_window: 32000
  max_output: 512
  temperature: 0.0
  cost_class: tiny
  latency_class: fast
}
```

| Field | Required | Type | Notes |
|---|---|---|---|
| `provider` | yes | enum | `ollama`, `openai_compat`, `llamacpp`, `koboldcpp`, `http` |
| `name` | yes | string | Provider-specific model identifier |
| `endpoint` | when provider != `ollama` | string | URL passed to the SSRF allowlist guard |
| `context_window` | no | uint | Tokens; default unspecified |
| `max_output` | no | uint | Cap on completion tokens |
| `temperature` | no | float | Default `0.0` for deterministic-friendly behaviour |
| `top_p` | no | float | |
| `stop` | no | list<string> | |
| `cost_class` | no | enum | `tiny | small | medium | large` — feeds the budget tracker |
| `latency_class` | no | enum | `fast | medium | slow` |
| `vram_mb` | no | uint | |
| `quant` | no | string | e.g. `Q4_K_M` |

### 11.1.2 `prompt`

Declares a typed prompt with execution policy: model/router, template, return type, validation, retry, timeout, cache, and allowed tools. The compiled body wraps a deterministic chat call with structured tracing.

```marrow
prompt classify_doc(body: string) {
  model: TinyClassifier
  template: "extension_point:tmpl_classify_doc"
  returns: string
  timeout: 5s
  idempotent: true
  validate: schema_only
  on_invalid: retry
  retry: { max_attempts: 2, backoff: fixed, interval: 200ms }
  cache: { key: hash(body), ttl: 1h }
}
```

| Field | Required | Type | Notes |
|---|---|---|---|
| `model:` | one of model/router | identifier | Static model reference |
| `router:` | one of model/router | identifier | Dynamic dispatch via a declared router |
| `template:` | yes | string | Inline literal or `extension_point:NAME` |
| `returns:` | yes | type | Used by `validate: schema_only` to derive a Zod schema |
| `validate:` | no | enum | `none | schema_only | ast_compiles | custom: <extension_point>` |
| `on_invalid:` | no | enum | `fail | retry | retry_with_repair_prompt | escalate` |
| `retry:` | no | RetryPolicy | `{ max_attempts, backoff, interval }` |
| `timeout:` | no | duration | Honoured by the per-call `AbortController` |
| `cache:` | no | object | `{ key: <expr>, ttl: <duration> }` |
| `idempotent:` | no | bool | Documentation; doesn't change emit |
| `constraints:` | no | list<expr> | Output-shape predicates |
| `tools:` | no | list<capability> | Closed allow-list (default empty) |

Mutual exclusion: a prompt declares `model:` **or** `router:`, never both. T022 enforces this at compile time.

### 11.1.3 `router`

Declares a deterministic decision tree for model dispatch. Tiers are evaluated in order against `by:`; the last tier is the default. There is no dynamic dispatch — the same input always selects the same tier.

```marrow
router cheapest_valid {
  by: input.complexity
  tier short  { max: 0.4 -> Tiny }
  tier medium { max: 0.7 -> Small }
  tier rest   {           -> Medium }
  on_low_confidence: escalate
  confidence_threshold: 0.65
  fallback: Medium
}
```

| Field | Required | Notes |
|---|---|---|
| `by:` | yes | Routing-key expression. The leading `input.` segment is stripped at compile time |
| `tier <name> { max: N -> Model }` | ≥ 1 | Ordered. Non-default tiers must declare `max:`; the **last** tier omits `max:` |
| `on_low_confidence:` | no | `fail | escalate | retry`. Default `fail` |
| `confidence_threshold:` | no | Below this, the prompt body throws a `low_confidence` error |
| `fallback:` | no | Model used when escalation exhausts the tier ladder |

Type-checker enforcement:
- T026: tier `max:` values must be monotonically increasing; the last tier must omit `max:`
- T025: every tier model must reference a declared `model`
- T027: `fallback:` must reference a declared `model`

### 11.1.4 `cognition:` capability modifier

A capability flagged with `cognition: <name>` dispatches to the **closed cognition catalog** (mirrors the existing `algorithm:` mechanism, see Chapter 5).

```marrow
capability slice_for_task(t: Task) {
  cognition: semantic_slice using {
    task: t.description,
    max_files: 8,
    hop_depth: 2
  }
  returns: SemanticSlice
  sync: eventual
  idempotent: true
}
```

T028 rejects names not present in `compiler/src/cognition_catalog.ts`. The closed v1 catalog has 12 primitives, organised by category:

| Category | Primitive | Calls model | Cost |
|---|---|---|---|
| memory | `compress_context` | yes | small |
| retrieval | `semantic_slice` | no | tiny |
| routing | `route_by_complexity` | no | free |
| routing | `tool_select` | yes | small |
| routing | `escalate_model` | no | free |
| validation | `self_critique` | yes | small |
| aggregation | `vote` | no | free |
| aggregation | `judge_pairwise` | yes | medium |
| aggregation | `argmax_score` | no | free |
| aggregation | `consensus_check` | no | free |
| recovery | `repair_with_diff` | yes | small |
| planning | `decompose_task` | yes | medium |

New primitives can ONLY be added by extending `cognition_catalog.ts`. The compiler never invents implementations — it picks from this list.

---

## 11.2 Lexer + Parser Surface

The lexer adds 36 new keyword tokens (see `compiler/src/lexer.ts:KEYWORDS`):

```
model, prompt, router, cognition, provider, endpoint,
template, tier, by, validate, on_invalid, cache, ttl, tools,
confidence_threshold, on_low_confidence, fallback,
context_window, max_output, temperature, top_p, stop,
cost_class, latency_class, vram_mb, quant,
ollama, openai_compat, llamacpp, koboldcpp, http,
schema_only, ast_compiles, retry_with_repair_prompt,
escalate, using
```

Parsers for the new top-level decls live in `compiler/src/parse_decls3.ts`. The capability parser (`parse_decls.ts`) was extended with a single new branch for `cognition:` mirroring the `algorithm:` branch.

---

## 11.3 Type Checker Rules

Stable error codes added by the cognition layer:

| Code | Rule |
|---|---|
| T020 | `model` declaration is missing required field (`provider` / `name` / `endpoint` for non-ollama providers) |
| T021 | `prompt.model` or `prompt.router` references an undeclared name |
| T022 | `prompt` declares both or neither of `model:` / `router:` |
| T023 | `prompt.tools:` list contains an undeclared capability |
| T024 | `prompt.template` references an undeclared `extension_point` |
| T025 | `router` tier references an undeclared model |
| T026 | `router` tier maxes are not monotonically increasing, or the last tier has an explicit `max:` |
| T027 | `router.fallback` references an undeclared model |
| T028 | Capability `cognition: <name>` references an unknown catalog primitive |

Existing error codes (T001 etc.) continue to apply across the new decls.

---

## 11.4 IR Additions

The IR (`compiler/src/ir.ts`) gains four new record types and threads them onto `IRSystem` and `IRMethod`:

```ts
export interface IRCogModel {
  id: string;
  name: string;
  provider: "ollama" | "openai_compat" | "llamacpp" | "koboldcpp" | "http";
  endpoint: string | null;
  model_name: string;
  context_window: number;
  max_output: number;
  temperature: number;
  top_p: number | null;
  stop: string[];
  cost_class: "tiny" | "small" | "medium" | "large";
  latency_class: "fast" | "medium" | "slow";
  vram_mb: number | null;
  quant: string | null;
}

export interface IRPrompt {
  id: string;
  name: string;
  input: IRField[];
  output_type: string;
  model_ref: string | null;
  router_ref: string | null;
  template: string;
  validate: { kind: "none" } | { kind: "schema_only" } | { kind: "ast_compiles" } | { kind: "custom"; extension_point: string };
  on_invalid: "fail" | "retry" | "retry_with_repair_prompt" | "escalate";
  retry: IRRetryPolicy | null;
  timeout_ms: number;
  cache: { key_expr: string; ttl_ms: number } | null;
  idempotent: boolean;
  constraints: string[];
  allowed_tools: string[];
}

export interface IRRouter {
  id: string;
  name: string;
  by_expr: string;
  tiers: { name: string; max: number | null; model_ref: string }[];
  on_low_confidence: "fail" | "escalate" | "retry";
  confidence_threshold: number;
  fallback_model_ref: string | null;
}

export interface IRCognitionBinding {
  catalog_name: string;
  bindings: { param: string; value: string }[];
}

// On IRSystem:        models, prompts, routers
// On IRMethod:        cognition (mirrors algorithm)
```

`IRCogModel` is intentionally named to avoid colliding with the existing `IRModel` record type used for data-store models (entities → tables).

All ordering is deterministic. No `Date.now()` or `Math.random()` in the IR layer.

---

## 11.5 Generated Artifacts

When at least one cognition surface exists, the full emitter (`compiler/src/emit_full.ts`) writes:

```
output/
├── src/
│   ├── cognition/
│   │   ├── router.ts          deterministic decision tree per router
│   │   ├── prompts.ts         one async fn per prompt
│   │   ├── primitives.ts      closed catalog impls (only those used)
│   │   ├── validate.ts        schema_only / ast_compiles / custom helpers
│   │   ├── repair.ts          per-prompt repair function (when used)
│   │   ├── budget.ts          BudgetTracker + BudgetExceededError
│   │   ├── cache.ts           memory / pg backends, deriveKey()
│   │   ├── traces.ts          writeSpan / loadTrace / 3 backends
│   │   └── index.ts           buildCtx, callPrompt, runCognition, newTraceId
│   ├── providers/
│   │   ├── types.ts           IModelProvider + ChatRequest/Response
│   │   ├── ssrf_guard.ts      assertEndpointAllowed
│   │   ├── ollama.ts          /api/chat
│   │   ├── openai_compat.ts   /chat/completions + logprobs
│   │   ├── llamacpp.ts        /completion + completion_probabilities
│   │   ├── koboldcpp.ts       /api/v1/generate
│   │   ├── http.ts            generic JSON
│   │   └── index.ts           registry, getModel, listModelNames
│   ├── memory/                (when memory primitives used)
│   │   ├── types.ts
│   │   ├── semantic_index.ts  TS AST + regex fallback
│   │   ├── retriever.ts       bounded BFS, hop_depth + max_files
│   │   ├── compressor.ts      token-budgeted summarisation
│   │   └── index.ts           getIndex singleton
│   ├── traces/
│   │   └── exporter.ts        OTLP/JSON exporter
│   └── (existing) routes/, state_machines/, flows.ts, ...
├── migrations/
│   ├── prompt_cache.sql       cache table
│   ├── cognition_traces.sql   23-col span table + 4 indexes
│   ├── semantic_index.sql     graph tables (when memory used)
│   └── (existing) audit_log.sql, event_outbox.sql
├── bin/index_sources.ts       offline indexer (when memory used)
└── (existing) admin/, openapi.yaml, k8s/, .env.example, ...
```

Files are emitted **only** when their feature is in use:

| File | Emitted when |
|---|---|
| `src/cognition/*` | `system.prompts.length > 0` or any `cognition:` capability |
| `src/providers/<name>.ts` | a model declares that provider |
| `src/memory/*`, `bin/index_sources.ts`, `migrations/semantic_index.sql` | any capability uses `semantic_slice` or `compress_context` |
| `src/cognition/cache.ts`, `migrations/prompt_cache.sql` | any prompt declares `cache:` |
| `src/cognition/repair.ts` | any prompt declares `on_invalid: retry_with_repair_prompt` |
| `src/cognition/traces.ts`, `src/traces/exporter.ts`, `migrations/cognition_traces.sql` | any prompt is declared |

A non-cognition project gets zero new files.

---

## 11.6 Runtime Behaviour

### 11.6.1 Prompt body lifecycle

For each `prompt` declaration, `emit_cognition.ts` emits an async function in `src/cognition/prompts.ts` that, on each call:

1. **Resolve model** — either `getModel(<model_ref>)` or `getRouter(<router_ref>).route(input)` followed by `__model = __routeChoice.model`.
2. **Render template** — call the extension-point function or use the inline literal.
3. **Cache lookup** — when `cache:` is declared, derive a key from `(prompt_name, model_id, template_hash, output_type, input)`, return on hit, write a `cache_hit` span.
4. **Budget gate** — `__budget.assertCanSpend(estimatedTokens, costClass)`. Throws `BudgetExceededError` (terminal — bypasses retry).
5. **Provider call** — `__model.provider.chat(req, abortSignal)` with the per-prompt `timeout:` wired into an `AbortController`.
6. **Parse output** — strip ``` fences, JSON.parse for `validate: schema_only`/`ast_compiles`, raw string otherwise.
7. **Low-confidence check** (when prompt routes through a router with `confidence_threshold > 0`) — if `__resp.confidence < threshold`, write a dedicated `low_confidence` span and throw an error tagged with `__validationIssues`, `__badOutput`, `__lowConfidence`.
8. **Validate** — call the appropriate `validateSchemaOnly` / `validateAstCompiles` / `validateCustom` from `src/cognition/validate.ts`.
9. **On invalid** — apply `on_invalid:` action:
   - `fail` — re-raise immediately
   - `retry` — fall through to next attempt within the `retry:` budget
   - `retry_with_repair_prompt` — call `REPAIRS[prompt_name]` (a smaller bounded prompt that takes `{original_input, bad_output, issues}`), re-validate, return on success or fall through
   - `escalate` — call `__router.escalate(currentTier)`; null at the top tier means re-raise
10. **Charge budget + cache** — record actual usage on `__budget`, write to `cache.put(...)` if applicable.
11. **Emit success span** with usage, tier, attempt, confidence.
12. **Return typed value**.

### 11.6.2 Span types (Phase 6 + 7)

Every observable boundary writes a row to `cognition_traces`:

| Kind | Status | Emitted when |
|---|---|---|
| `prompt_call` | `ok` | provider returned valid output |
| `prompt_call` | `provider_error` | provider threw or aborted |
| `cache_hit` | `cache_hit` | cache returned a value |
| `validate` | `validate_failed` | validation rejected the output |
| `repair` | `repair_accepted` | repair re-validation succeeded |
| `repair` | `repair_rejected` | repair re-validation failed |
| `escalate` | `escalated` | router moved up one tier |
| `low_confidence` | `low_confidence` | confidence below threshold |
| `budget_exceeded` | `budget_exceeded` | budget guard pre-empted the call |

Spans are linked by `(trace_id, parent_span_id)` and form a tree per workflow. The runtime writer **never throws** on persistence failures — observability must never block a prompt.

### 11.6.3 Cognition primitives

Used primitives are emitted as async functions in `src/cognition/primitives.ts`. Each receives a `(args, ctx)` pair where `ctx: CognitionCtx` exposes:

```ts
interface CognitionCtx {
  trace_id: string;
  signal?: AbortSignal;
  prompts: { get(name: string): PromptFn | null; findSummarizer(): PromptFn | null };
  routers: { get(name: string): CompiledRouter | null };
  memory: { getIndex(): SemanticIndex | null };
  logger: typeof logger;
  metrics: { counter: typeof counter };
}
```

`runCognition(name, args)` is the public entry point — it builds a context with a fresh `trace_id` and dispatches.

---

## 11.7 Determinism Discipline

The cognition layer adheres to the same discipline as the rest of the compiler (Chapter 8):

1. **Compiler is bitwise deterministic.** Every new emitter passes `marrowc verify-determinism` (`compiler/src/cli.ts:runVerifyDeterminism`). All sorts are explicit; no `Date.now()`, no `Math.random()` in emitters or emitted code.
2. **Routing is deterministic.** The router emits an ordered if-else chain over `by_expr`. Same input always selects the same tier.
3. **Caching is deterministic.** Default key is `sha256(canonicalize(input)) + "|" + model_ref + "|" + template_hash`. User-supplied `key:` expressions are evaluated against typed input via a narrow whitelist (`hash(field)` and dotted paths only — anything else degrades to the default key).
4. **Replay mode.** `marrowc replay <trace_id>` reads spans from `cognition_traces` and prints a human-readable summary plus a JSON fixture file usable as a stub provider in tests.
5. **Tracing is deterministic given a `trace_id`.** Two runs with the same trace store reset, the same prompt-cache reset, and the same inputs produce byte-identical span sequences (verified in `test_cognition_phase6.ts`).

The single intentional source of non-determinism is the model itself, and it is wrapped in:
- typed input + output validation
- bounded retry + repair
- caching keyed on the call surface
- spans on every boundary

---

## 11.8 Constraints On What The Harness Will NOT Do

To keep the harness honest about being a cognitive scaffold for weak models, not another agent framework:

- **No autonomous "agent" loop.** There is no top-level `think → act → reflect` runtime. Every loop is a compile-time `pipeline` or `flow`.
- **No model-driven workflow mutation.** Workflows are immutable artifacts of compilation.
- **No model-driven tool discovery.** The `tools:` list is closed and type-checked.
- **No memory the model writes to directly.** The semantic index is updated by deterministic indexers; the model only reads slices.
- **No giant system prompts.** Templates are typed and parameterised through `extension_point` bodies.
- **No vector RAG by default.** The first-class retrieval path is graph-based semantic slicing.
- **No long-term planning by the model.** Plans are decomposed by `decompose_task` into bounded subtasks drawn from a closed list.

---

## 11.9 Environment Variables

Generated `.env.example` adds:

```
LLM_PROVIDER_DEFAULT=ollama
LLM_ENDPOINT_ALLOWLIST=         # comma-separated URL prefixes
LLM_ALLOW_PUBLIC_ENDPOINTS=     # 1 disables the host filter (production-only)
LLM_BUDGET_TOKENS_PER_TRACE=    # opt-in token ceiling per trace
LLM_BUDGET_USD_PER_TRACE=       # opt-in USD ceiling per trace
LLM_TRACES_BACKEND=memory       # memory | pg | none
LLM_MEMORY_ROOT=                # path the offline indexer walks (when memory used)
OLLAMA_HOST=http://127.0.0.1:11434
OPENAI_COMPAT_API_KEY=          # bearer for openai_compat servers (vLLM auth, OpenAI, ...)
OTEL_EXPORTER_OTLP_ENDPOINT=    # optional OTLP/JSON span exporter
OTEL_SERVICE_NAME=
```

The SSRF guard rejects endpoints outside loopback / RFC1918 unless explicitly allow-listed.

---

## 11.10 Examples

Two real `.marrow` files in `examples/` demonstrate the whole picture:

- **`examples/triage_harness.marrow`** — issue triage. Two models, one router, classifier + summariser prompts, a transactional pipeline. Compiles to a deployable Express service with audit, traces, prompt cache, and budget gauges.
- **`examples/patch_harness.marrow`** — code-patch generation. Three models, a tier ladder, `semantic_slice` for bounded retrieval, `compress_context` for window management, `validate: ast_compiles` over the generator output, `on_invalid: retry_with_repair_prompt` with a smaller scope, plus a flow with explicit compensations.

A minimal starting scaffold is available via:

```bash
marrowc init my_harness --domain cognitive_scaffold
```

This writes a single-prompt `.marrow` file plus a README. Run `marrowc compile my_harness.marrow` to produce the full output tree.
