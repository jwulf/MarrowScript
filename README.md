# MarrowScript

MarrowScript is a declarative language that compiles `.marrow` files into complete, runnable Node.js backends. You describe your system once and get back a full production-ready project: database migrations, API routes, auth, events, SDK, Dockerfile, CI pipeline, and more.

Same input always produces identical output. No surprises, no hidden magic.

```marrow
system Shop {
  entity Product {
    owns: [name: string, price: uint, stock: uint]
    constraints: [price > 0, stock >= 0]
    states: available -> sold_out | archived
  }

  capability purchase(buyer: User, product: Product, qty: uint) {
    requires: [product.stock >= qty, buyer.balance >= product.price * qty]
    effects: [product.stock -= qty, buyer.balance -= product.price * qty]
    emits: OrderPlaced
    sync: transactional
  }

  event OrderPlaced {
    payload: { order_id: uuid, buyer_id: uuid, total: uint }
    delivery: exactly_once
    ttl: 90d
  }

  policy api_security {
    rate_limit: 100 per 1m
    audit: true
  }
}
```

Run `marrowc compile shop.marrow` and get back a complete project with an Express API, PostgreSQL migrations, JWT auth, transactional SQL, durable events, WebSocket support, OpenAPI spec, TypeScript SDK, React hooks, Zod schemas, admin panel, Dockerfile, and GitHub Actions CI.

---

## Install

```bash
npm install -g marrowscript-compiler
```

Or run without installing:

```bash
npx marrowscript-compiler compile shop.marrow
```

Requires Node.js 18 or later.

---

## Quick Start

```bash
# 1. Create a new project from a template
marrowc init my-app --domain saas_platform

# 2. Compile it
marrowc compile my-app/my-app.marrow

# 3. Set up your environment
cp my-app/output/.env.example my-app/output/.env
# Open .env and set JWT_SECRET to a random string:
# node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 4. Start it
cd my-app/output
npm install
docker compose up -d
npm run migrate
npm run dev
# Running at http://localhost:3000
# Admin panel at http://localhost:3000/admin
```

No database setup required beyond Docker. Postgres and Redis start automatically from the generated `docker-compose.yaml`.

---

## Using MarrowScript with an LLM

MarrowScript is a great fit for AI-assisted backend development. The language is structured and constrained enough that LLMs produce clean, valid `.marrow` files reliably.

### Prompting an LLM to write a .marrow file

Give the model a task description and the MarrowScript syntax. A useful prompt looks like this:

```
You are writing a MarrowScript (.marrow) system definition.

MarrowScript uses: entity (data), capability (operations), event (domain events),
policy (rate limits, audit), flow (sagas), channel (websockets).

Write a system for: [describe your system here]

Rules:
- entity fields use: string, uint, int, float, bool, timestamp, uuid, json
- capability requires: are preconditions, effects: are mutations, emits: fires events
- sync: transactional means the capability runs in a DB transaction
- states use: state1 -> state2 | terminated
- policy sets rate_limit, audit, encryption
```

Then paste in the shop example above so the model understands the syntax. Most frontier models produce valid `.marrow` files on the first or second try.

### Using reflect-llm to convert existing code

If you have an existing TypeScript project, MarrowScript can infer a `.marrow` stub from it automatically:

```bash
# Static inference from TypeScript (no LLM needed)
marrowc reflect ./my-existing-project --out my_project.marrow

# LLM-assisted inference (detects capabilities and state machines)
marrowc reflect-llm ./my-existing-project --out my_project.marrow

# With a custom endpoint (LM Studio, vLLM, etc.)
marrowc reflect-llm ./my-existing-project --endpoint http://localhost:1234/v1 --model phi-3.5-mini
```

The reflect command walks your TypeScript source, finds entity-shaped classes and interfaces, and writes a `.marrow` stub you can review and compile.

### Using the LLM harness (cognition layer)

MarrowScript can also compile backends that call LLMs as part of their business logic. Declare models, prompts, and routers in your `.marrow` file:

```marrow
model Classifier {
  provider: openai_compat
  endpoint: "http://localhost:1234/v1"
  name: "phi-3.5-mini"
  context_window: 128000
  max_output: 512
  temperature: 0.0
  cost_class: small
  latency_class: fast
}

prompt classify_ticket(body: string) {
  model: Classifier
  template: "extension_point:tmpl_classify"
  returns: string
  validate: schema_only
  on_invalid: retry
  retry: { max_attempts: 2, backoff: fixed, interval: 200ms }
  cache: { key: hash(body), ttl: 1h }
}
```

The compiler generates the provider adapters, retry logic, cache tables, trace tables, and budget enforcement. You provide the prompt templates via extension points. Works with any OpenAI-compatible endpoint including LM Studio, Ollama, OpenRouter, and vLLM.

---

## Features

### Entities

Entities are your data models. They have fields, constraints, state machines, relations, and optional indexes. Every entity gets a full set of CRUD routes automatically.

```marrow
entity Order {
  owns: [
    buyer_id: uuid,
    total: uint,
    status: string,
    notes: string
  ]
  constraints: [
    total > 0,
    status in ["pending", "paid", "shipped", "delivered", "cancelled"]
  ]
  states: pending -> paid -> shipped -> delivered | cancelled
  relation buyer: belongs_to User
  index: [buyer_id, status]
}
```

Field types: `string`, `uint`, `int`, `float`, `bool`, `timestamp`, `uuid`, `bytes`, `json`, `list<T>`, `set<T>`, `optional<T>`

Mark sensitive fields with `@sensitive` so the audit middleware redacts them from logs:

```marrow
entity User {
  owns: [
    email: string @sensitive,
    payment_token: string @sensitive,
    username: string
  ]
}
```

Use `@renamed_from` to generate safe `ALTER TABLE ... RENAME COLUMN` migrations:

```marrow
email_address: string @renamed_from(email)
```

### Capabilities

Capabilities are the operations your system can perform. They declare preconditions that must be true before the operation runs, effects that describe what changes, and events that fire when it succeeds.

```marrow
capability ship_order(seller: Seller, order: Order) {
  requires: [
    order.status == "paid",
    order.seller_id == seller.id,
    caller.id == seller.id
  ]
  effects: [
    order.status = "shipped"
  ]
  emits: OrderShipped
  sync: transactional
  timeout: 10s
  idempotent: true
  retry: { max_attempts: 3, backoff: exponential, interval: 1s }
}
```

`sync: transactional` wraps the operation in a database transaction. `sync: eventual` runs asynchronously. The `caller` built-in resolves to the authenticated actor's ID for ownership checks.

Effects support assignment (`=`), increment (`+=`), and decrement (`-=`). When an effect targets an entity field, the compiler generates the correct SQL `UPDATE` statement automatically.

### Events

Events are immutable records that fire when capabilities succeed. They get stored in a transactional outbox and delivered with the guarantees you specify.

```marrow
event OrderShipped {
  payload: {
    order_id: uuid,
    seller_id: uuid,
    shipped_at: timestamp
  }
  delivery: exactly_once
  ttl: 30d
}
```

Delivery modes: `at_least_once`, `at_most_once`, `exactly_once`

Switch between in-memory and durable delivery via environment variable:

```bash
EVENT_MODE=in_process   # fast, no persistence (default for dev)
EVENT_MODE=durable      # Postgres-backed transactional outbox
```

### Flows (Sagas)

Flows are multi-step operations where each step can be compensated if something goes wrong. The compiler generates a saga runtime that runs steps in order and rolls back on failure.

```marrow
flow checkout {
  step reserve_stock: reserve_items(cart.items)
    compensate: release_items(cart.items)

  step charge: process_payment(buyer, cart.total)
    compensate: refund_payment(buyer, cart.total)

  step confirm: create_order(buyer, cart)
}
```

### Channels (WebSockets)

Channels declare real-time communication surfaces. The compiler generates a WebSocket server wired to your entities and events automatically.

```marrow
channel trade_feed {
  transport: websocket
  ordering: fifo
  participants: set<User>
  persistence: last_50
  filter: participant.id == event.to_user
}
```

Ordering options: `fifo`, `causal`, `total`, `unordered`

### Policies

Policies attach rate limiting, audit logging, and access control to your routes. Declare one policy and it applies to all the modules that reference it.

```marrow
policy api_security {
  rate_limit: 100 per 1m
  access: [user, admin]
  audit: true
  encryption: both
}
```

Add cost budgets to enforce per-tenant or per-user LLM spend limits:

```marrow
policy llm_limits {
  cost_budgets: [
    { scope: per_tenant, window: 1h, cap_usd: 1.00, on_exceeded: error },
    { scope: per_user, window: 1d, cap_tokens: 50000, on_exceeded: throttle, retry_after: 15m }
  ]
}
```

### Pipelines

Pipelines let you compose multiple capability calls into a single operation, with parallel execution and typed error handling.

```marrow
capability process_checkout(buyer: Buyer, cart: Cart) {
  pipeline: {
    validate_cart(cart)
    charge_payment(buyer, cart.total) as payment
    create_order(buyer, cart, payment)
    on_error: rollback
  }
  sync: transactional
}
```

Use `parallel: true` to run pipeline steps concurrently when they have no dependencies on each other.

### Stores

Stores declare how your data is physically stored. Most of the time you use the defaults, but stores let you configure replicas, partitioning, and retention.

```marrow
store OrderStore {
  engine: postgresql
  schema: {
    id: uuid,
    buyer_id: uuid,
    total: uint,
    status: string,
    created_at: timestamp
  }
  partition: buyer_id
  replicas: 2
}

store SessionStore {
  engine: redis
  schema: {
    token: string,
    user_id: uuid,
    expires_at: timestamp
  }
  retention: 24h
}
```

### State Machines

Declare state machines directly on entities using a simple arrow syntax. The compiler generates a typed state machine runtime and validates all transitions at compile time.

```marrow
entity Listing {
  states: draft -> published -> sold | archived
}
```

This generates a `ListingState` type, a `LISTING_TRANSITIONS` table, and a `transitionListing(current, trigger)` function with full type safety. Invalid transitions return a typed error rather than throwing.

### Relations

Relations are declared on entities and generate SQL foreign key constraints, indexes, and junction tables automatically.

```marrow
entity Listing {
  relation seller: belongs_to Seller
  relation reviews: has_many Review
  relation categories: many_to_many Category
}
```

Relation types: `belongs_to`, `has_one`, `has_many`, `many_to_many`

### Algorithms

Reference algorithms from a built-in catalog directly in capability bodies. The compiler generates the implementation and wires it in.

```marrow
capability find_route(start: string, end: string) {
  algorithm: shortest_path using {
    graph: road_network,
    source: start,
    target: end
  }
  returns: json
}
```

Available algorithms: `shortest_path`, `topological_sort`, `binary_search`, `bipartite_matching`, `round_robin`, `weighted_average`, `percentile`, `rank_by`, `consistent_hash`

### Extension Points

Extension points are escape hatches for custom logic that the compiler cannot generate. Declare one in your `.marrow` file and implement it in TypeScript. The implementation is preserved across recompiles.

```marrow
extension_point calculate_shipping_fee(order: Order) {
  returns: uint
  stable: true
}
```

Mark it `stable: true` and the compiler will error if the implementation is missing.

### LLM Models and Prompts

When your backend needs to call a language model, declare it in the `.marrow` file instead of wiring it by hand. The compiler generates provider adapters, retry logic, caching, tracing, and validation automatically.

```marrow
model SmallModel {
  provider: openai_compat
  endpoint: "http://localhost:1234/v1"
  name: "phi-3.5-mini"
  context_window: 128000
  max_output: 2048
  temperature: 0.0
  cost_class: small
  latency_class: fast
}

prompt summarize(text: string) {
  model: SmallModel
  template: "extension_point:tmpl_summarize"
  returns: string
  timeout: 30s
  validate: schema_only
  on_invalid: retry_with_repair_prompt
  retry: { max_attempts: 3, backoff: exponential, interval: 1s }
  cache: { key: hash(text), ttl: 1h }
}
```

Supported providers: `openai_compat` (LM Studio, vLLM, OpenRouter, OpenAI), `ollama`, `llamacpp`, `koboldcpp`, `http`

### Routers

Routers let you route prompt calls to different models based on input characteristics. Define tiers with cost/latency tradeoffs and let the runtime pick the right model automatically.

```marrow
router cost_aware {
  by: input.complexity
  tier short  { max: 0.3 -> TinyModel }
  tier medium {            -> SmallModel }
  on_low_confidence: escalate
  confidence_threshold: 0.65
  fallback: SmallModel
}
```

### Evaluations

Evaluations are typed regression tests for prompts. Declare test cases with expected output characteristics and run them with `marrowc evaluate` to catch prompt regressions in CI.

```marrow
evaluation test_classifier {
  prompt: classify_ticket
  case short_bug {
    input: { body: "Button crashes on click" }
    expects: [
      passes: schema_only,
      must_contain_string: ["bug"]
    ]
  }
  baseline: { min_pass_rate: 0.90 }
  schedule: { on: ["ci_pr"] }
}
```

---

## What Gets Generated

```
output/
├── src/
│   ├── index.ts            Express server, all routes wired
│   ├── db.ts               Postgres connection pool
│   ├── auth.ts             JWT middleware (algorithm-pinned HS256)
│   ├── events.ts           Durable event bus (transactional outbox)
│   ├── audit.ts            Audit log middleware
│   ├── notify.ts           Email and webhook notifications
│   ├── cron.ts             Scheduled job stubs (node-cron)
│   ├── schemas.ts          Zod validation schemas
│   ├── health.ts           /health/live, /health/ready, /health/metrics
│   ├── logger.ts           Structured logging
│   ├── metrics.ts          Prometheus-style counters
│   ├── flows.ts            Saga runtime with compensation
│   ├── routes/             One file per entity
│   ├── state_machines/     One file per entity with states
│   └── cognition/          LLM harness (when prompts are declared)
├── sdk/
│   ├── client.ts           Typed TypeScript fetch client
│   └── react.ts            React hooks (useList, useCreate, etc.)
├── admin/
│   └── index.html          Self-contained admin panel
├── migrations/             SQL schemas, indexes, triggers, FKs
├── openapi.yaml            OpenAPI 3.0.3 spec
├── schema.graphql          GraphQL schema
├── {Name}.postman_collection.json
├── Dockerfile
├── docker-compose.yaml
└── .github/workflows/ci.yaml
```

---

## Compile Targets

```bash
# Full Express + PostgreSQL backend (default)
marrowc compile app.marrow

# Nakama TypeScript runtime (game backends)
marrowc compile app.marrow --target nakama

# Prisma schema only
marrowc compile app.marrow --target prisma

# SQLite migrations + DB client (schema-only, no routes)
marrowc compile app.marrow --target sqlite
```

Flags for the express target:

```bash
--no-sdk        Skip sdk/client.ts and sdk/react.ts
--no-openapi    Skip openapi.yaml, schema.graphql, Postman collection
--no-seed       Skip src/seed.ts
```

---

## Commands

| Command | What it does |
|---------|--------------|
| `marrowc compile <file>` | Full compilation to runnable project |
| `marrowc check <file>` | Type-check without generating code |
| `marrowc validate [dir]` | Run `tsc --noEmit` on generated output |
| `marrowc fmt <file>` | Format in place |
| `marrowc watch <file>` | Recompile on save |
| `marrowc init <name> --domain <name>` | Scaffold from a domain template |
| `marrowc diff <old.marrow> <new.marrow>` | Show schema migration diff |
| `marrowc reflect <project_dir>` | Infer a .marrow stub from existing TypeScript |
| `marrowc reflect-llm <project_dir>` | LLM-assisted inference of capabilities |
| `marrowc trace-to-test <trace.json>` | Convert a recorded LLM trace to a regression test |
| `marrowc tune-router <name>` | Analyze recorded traces against a router policy |
| `marrowc verify-determinism <file>` | Confirm two compilations produce identical output |

### Domain Templates

Start from a template with `marrowc init my-app --domain <name>`:

| Template | Good for |
|----------|----------|
| `saas_platform` | SaaS products with multi-tenant auth, billing, subscriptions |
| `marketplace` | Buyer/seller platforms with listings, orders, reviews |
| `multiplayer_game` | Game backends with inventory, trading, leaderboards |
| `social_network` | Follow graphs, feeds, messaging, notifications |
| `iot_system` | Device management, telemetry ingestion, alerting |
| `realtime_collaboration` | Shared editing, presence, live cursors |
| `cognitive_scaffold` | LLM harness with prompt routing and budget enforcement |

---

## Environment Variables

The generated `.env.example` documents every variable. Core ones:

```bash
# Required in production
JWT_SECRET=          # min 32 chars, generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
DATABASE_URL=        # postgresql://user:pass@host:5432/dbname

# Optional
REDIS_URL=           # redis://localhost:6379
PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=     # comma-separated, e.g. https://app.example.com

# Event delivery
EVENT_MODE=in_process   # or: durable

# Notifications
NOTIFY_PROVIDER=log     # or: resend, sendgrid, webhook
NOTIFY_API_KEY=
NOTIFY_FROM_EMAIL=

# LLM harness (only when prompts are declared)
OPENAI_COMPAT_API_KEY=
OLLAMA_HOST=
LLM_ENDPOINT_ALLOWLIST=
LLM_BUDGET_TOKENS_PER_TRACE=
LLM_BUDGET_USD_PER_TRACE=
```

---

## 5 Projects Built for MarrowScript

### 1. SaaS Dashboard Product

A standard SaaS product with users, teams, subscriptions, and billing has a lot of plumbing. Routes for every resource, role-based access, audit trails, email notifications when plans change, state machines for subscription status, webhooks to billing providers. MarrowScript generates all of it from a spec file. You write the business logic in extension points and skip the infrastructure entirely. The `saas_platform` template gets you to a running product in about 10 minutes.

### 2. Multiplayer Game Backend

Game backends need fast writes, real-time messaging between players, item trading, leaderboards, and session management. MarrowScript's `channel` and WebSocket generation, combined with the `nakama` compile target, means you get a game server with typed trade capabilities, inventory state machines, and real-time lobbies without writing a line of socket code. The `multiplayer_game` template includes player auth, item stores, trade flows with compensation, and WebSocket channels out of the box.

### 3. AI-Powered API

If you are building a product where users submit requests and your backend calls an LLM to fulfill them, the cognition layer is exactly what you need. Declare your models, prompts, and confidence-based routers in the `.marrow` file. The compiler generates provider adapters, response validation, retry with repair prompts, prompt caching, per-tenant cost budgets, and trace storage. You focus on the prompt templates. Everything else is handled.

### 4. Marketplace or Auction Platform

Marketplaces have strict transactional requirements: a listing can only be purchased once, funds need to move atomically, disputes need audit trails, and sellers need notifications. MarrowScript's `sync: transactional` capabilities, durable events, and audit middleware make these requirements easy to express. The `marketplace` template ships with Seller, Listing, Order, Review, and Buyer entities, a complete checkout flow with compensation, and state machines on every entity.

### 5. IoT Data Platform

IoT backends have to ingest high-frequency telemetry, route alerts, enforce device-level rate limits, and maintain audit logs for compliance. MarrowScript's store declarations with partition keys, the event system with `at_least_once` delivery, and the policy rate limiting map cleanly onto these requirements. The `iot_system` template gives you device management, telemetry ingestion, alert routing, and API key auth.

---

## Project Structure

```
spec/           Language spec (formal documents)
compiler/       Compiler source (TypeScript) — marrowscript-compiler on npm
  src/          Lexer, parser, type checker, IR, emitters, CLI
lsp/            Language Server (LSP)
vscode-ext/     VS Code extension
examples/       Example .marrow files
```

---

## VS Code Extension

```bash
.\install-extension.ps1
```

Gives you syntax highlighting, real-time error diagnostics, completions, hover docs, go-to-definition, and document outline for `.marrow` files.

---

## Links

- **npm**: [npmjs.com/package/marrowscript-compiler](https://www.npmjs.com/package/marrowscript-compiler)
- **GitHub**: [github.com/Doorman11991/MarrowScript](https://github.com/Doorman11991/MarrowScript)

---

## License

Copyright (c) 2026 ExoCode. All rights reserved.

MarrowScript is source-available. You may read, study, fork, and use this software for personal and internal commercial purposes under the following terms:

1. You may use MarrowScript to build and operate products, services, and internal tools.
2. You may not sell, license, sublicense, or distribute MarrowScript itself or a substantially similar compiler or language toolchain as a standalone product or service.
3. You may not offer MarrowScript as a hosted service (SaaS, PaaS, cloud compiler service, or equivalent) without a separate written agreement with ExoCode.
4. You must retain all copyright notices in any copy or derivative work.
5. Contributions submitted to this repository are licensed back to ExoCode under these same terms.

Generated output (the code produced by running `marrowc compile`) is yours. ExoCode makes no claim on anything you build with MarrowScript.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
