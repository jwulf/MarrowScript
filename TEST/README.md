# MarrowForge

**An intelligent code & architecture forge powered by MarrowScript.**

MarrowForge takes vague ideas, feature requests, bug reports, or messy code snippets and turns them into clean, production-ready code artifacts with full traceability. It runs on two real LLMs:

- **Tiny** — LM Studio, `huihui-gemma-4-e4b-it-abliterated` (~4B params, on-device)
- **Medium** — OpenRouter, `deepseek/deepseek-chat-v3-0324` (escalation tier)

The pipeline is `analyze → slice → generate → save`. Every step is a typed deterministic call. Every prompt invocation writes a span to `cognition_traces`. Bad output triggers a bounded single-shot repair. Same input always selects the same router tier. The model is constrained; the runtime is intelligent.

---

## Files in this folder

| File | What it is |
|---|---|
| `marrowforge.marrow` | The full system declaration — entities, models, router, prompts, capabilities, policy. |
| `extensions_starter.ts` | Recommended bodies for the two `extension_point` templates plus a small result-assembly helper. |
| `output/` | What `marrowc compile` produced. Self-contained Node.js project: 65 files, runnable. |

---

## Compiling

From the repo root (one level up):

```powershell
cd BoneScript\compiler
npx ts-node src/cli.ts compile ..\TEST\marrowforge.marrow ..\TEST\output
```

You'll see two expected "Extension point errors" telling you to fill in `tmpl_analyze` and `tmpl_generate`. That's by design — `stable: true` means the user owns those bodies. Open `output/src/extensions.ts`, find the sentinel-bracketed regions for each template, and paste in the corresponding function body from `extensions_starter.ts`.

Sentinels look like:

```ts
// <marrowscript:ext:tmpl_analyze:begin>
return ""; // ← replace this
// <marrowscript:ext:tmpl_analyze:end>
```

Future `marrowc compile` runs preserve everything between the sentinels.

---

## Running

### 1. Set up the providers

**LM Studio (Tiny):** Launch LM Studio, load `huihui-gemma-4-e4b-it-abliterated`, click **Start Server**. The default endpoint is `http://127.0.0.1:1234/v1` (matches `marrowforge.marrow`'s `endpoint:`).

**OpenRouter (Medium):** Get an API key at https://openrouter.ai/keys.

### 2. Configure environment

Create `output/.env` from `output/.env.example` and set:

```env
# Database (for ForgeRequest, ForgeResult, audit_log, event_outbox, cognition_traces, prompt_cache, semantic_index)
DATABASE_URL=postgres://forge:forge@localhost:5432/marrowforge

# Auth — JWT secret for the API
JWT_SECRET=replace-me-with-a-real-secret

# OpenRouter — required for Medium tier escalation
OPENAI_COMPAT_API_KEY=sk-or-v1-...

# SSRF guard — must allow OpenRouter explicitly
LLM_ENDPOINT_ALLOWLIST=https://openrouter.ai

# Trace backend — start with memory for dev, switch to pg for prod
LLM_TRACES_BACKEND=memory

# Optional budget caps. Leave unset = no enforcement.
# LLM_BUDGET_TOKENS_PER_TRACE=200000
# LLM_BUDGET_USD_PER_TRACE=0.50

# Memory layer — point at a directory the indexer should walk
LLM_MEMORY_ROOT=./src
```

The SSRF allowlist line is critical. Without it, the runtime refuses to call `https://openrouter.ai` because the default policy only permits loopback (`127.0.0.0/8`) and RFC1918 ranges. That's deliberate — exfil hardening by default.

### 3. Install + migrate + seed

```powershell
cd output
npm install
npm run migrate     # applies all 7 migrations: forge_request, forge_result, prompt_cache, cognition_traces, semantic_index, audit_log, event_outbox
```

### 4. Build the semantic index (offline)

```powershell
npx ts-node bin/index_sources.ts
```

This walks `LLM_MEMORY_ROOT` and populates the `symbols`, `imports`, and `calls` tables. The `semantic_slice` capability reads from those tables.

### 5. Start the server

```powershell
npm run dev
```

It listens on `http://127.0.0.1:3000`. The OpenAPI spec is at `output/openapi.yaml`; the Postman collection at `output/MarrowForge.postman_collection.json`.

### 6. Forge something

First, create a request row (the pipeline reads it back by id):

```powershell
$req = Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3000/forge-requests `
  -Headers @{ Authorization = "Bearer $env:JWT_TOKEN"; 'Content-Type' = 'application/json' } `
  -Body (@{
    title = "Add a /health/llm endpoint"
    description = "Add an Express handler at GET /health/llm that returns { ok: true, providers: ['ollama','openai_compat'] } as JSON."
    desired_kind = "endpoint"
    target_path = "src/routes/health_llm.ts"
    complexity = 0.3
  } | ConvertTo-Json)
```

Then forge it:

```powershell
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3000/forge-requests/forge `
  -Headers @{ Authorization = "Bearer $env:JWT_TOKEN"; 'Content-Type' = 'application/json' } `
  -Body (@{ r_id = $req.id } | ConvertTo-Json)
```

Response shape:

```json
{
  "ok": true,
  "value": {
    "analysis": "{\"kind\":\"endpoint\",\"summary\":\"...\",\"plan\":\"1. ...\\n2. ...\",\"target_symbol\":\"GetHealthLlmHandler\",\"complexity\":0.3}",
    "slice":    { "files": ["src/health.ts", "src/index.ts"], "symbols": [...], "target_symbol": "..." },
    "artifact": "```typescript\nexport function GetHealthLlmHandler(req, res) { ... }\n```"
  }
}
```

Inspect the trace:

```powershell
# The trace id is logged on the server side. Or query the table:
psql $env:DATABASE_URL -c "SELECT span_id, kind, status, model, latency_ms FROM cognition_traces ORDER BY started_at DESC LIMIT 20"
```

Or replay it offline:

```powershell
cd ..\compiler
npx ts-node src/cli.ts replay <trace_id>
```

---

## What the pipeline actually does

1. **`analyze_forge_request`** runs on Tiny (LM Studio). The prompt asks for JSON with five fields. `validate: schema_only` rejects non-string output. Bad responses retry up to 3 times with exponential backoff. Cached by `hash(description)` for 1 hour.
2. **`slice_codebase`** walks the symbol/dependency graph that `bin/index_sources.ts` built. `hop_depth: 2`, `max_files: 8`. No model call — pure deterministic graph traversal.
3. **`generate_forge_artifact`** routes through `forge_router`:
   - Complexity ≤ 0.5 → Tiny.
   - Complexity > 0.5 → Medium.
   - Confidence below 0.6 → escalate one tier (and retry the call on the new model).
   - Output goes through `validate: ast_compiles` (parses the code with tsc).
   - On invalid output → `retry_with_repair_prompt` calls a smaller bounded repair prompt that re-validates.
   - Cached by `hash(plan)` for 24 hours.

Every boundary writes a span. The schema is in `migrations/cognition_traces.sql` — 23 columns including `confidence`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `cache_hit`, `validate_result`, `error_code`.

---

## Routes generated

| Method | Path | What |
|---|---|---|
| `POST` | `/forge-requests` | Create a ForgeRequest row |
| `POST` | `/forge-requests/forge` | Run the full pipeline (this is the public entry) |
| `POST` | `/forge-requests/slice-codebase` | Just the retrieval step (debugging) |
| `POST` | `/forge-results` | Create a result row directly (admin) |
| `POST` | `/forge-results/save-forge-result` | Mark a result saved + emit ArtifactForged |
| `POST` | `/forge-results/mark-forge-failed` | Mark a result failed + emit ForgeFailed |
| `GET`  | `/health/ready` | Readiness probe (DB + provider reachability) |
| `GET`  | `/metrics` | Prometheus metrics including `cognition.prompt_calls`, `cognition.prompt_tokens`, `cognition.cache_hits`, `cognition.escalations`, `cognition.budget_exceeded` |

---

## Determinism check

```powershell
cd ..\compiler
npx ts-node src/cli.ts verify-determinism ..\TEST\marrowforge.marrow
# Should print: Output hash: <16 hex chars> with "Deterministic. Both runs produced identical output."
```

The compiler is bitwise deterministic. Any drift in the output hash between runs would mean a regression in some emitter.

---

## Why this is interesting

- **No agent loop.** There's no `think → act → reflect` runtime. The pipeline is a compile-time DAG. Same `ForgeRequest` produces the same call sequence every single time.
- **Budgets are first-class.** `LLM_BUDGET_TOKENS_PER_TRACE` is enforced before each provider call. `BudgetExceededError` is terminal — it bypasses retry, gets its own span kind (`budget_exceeded`), and shows up in the auto-derived failure-rules list.
- **Replay is real.** Trace storage isn't aspirational logging — `marrowc replay <trace_id>` reads spans from the table and reconstructs the call sequence with recorded inputs / outputs. Incident reproduction is just a CLI command.
- **Memory is graph-based, not vector.** No fuzzy embedding lookups; no whole-repo dumps. The symbol graph gives the generator a small, accurate, deterministic slice — bounded by `hop_depth` + `max_files`.
- **The closed catalog.** The cognition primitives (`semantic_slice`, `compress_context`, `vote`, `judge_pairwise`, ...) live in `compiler/src/cognition_catalog.ts`. The compiler can't invent new ones. Type-check error T028 rejects unknown names. The runtime can be audited end-to-end.

The model is constrained. The runtime is intelligent.
