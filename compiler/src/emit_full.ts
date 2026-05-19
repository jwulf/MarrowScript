/**
 * MarrowScript Full Emitter Ã¢â‚¬â€ Produces a complete, runnable project.
 * Combines schema generation with runtime service code.
 */

import * as IR from "./ir";
import { Emitter, EmittedFile } from "./emitter";
import {
  emitPackageJson,
  emitTsConfig,
  emitDbClient,
  emitAuthMiddleware,
  emitEntityRouter,
  emitStateMachineRuntime,
  emitIndex,
  emitMigration,
} from "./emit_runtime";
import { emitWebSocketServer } from "./emit_websocket";
import {
  emitLogger,
  emitMetrics,
  emitHealthChecks,
  emitFailureRules,
  emitMigrationDiff,
} from "./emit_maintenance";
import { emitFlowRuntime } from "./emit_extras";
import { emitAlgorithmsFile, collectUsedAlgorithms } from "./emit_composition";
import { emitExtensionPointStub } from "./extension_manager";
import * as AST from "./ast";
import { emitDurableEventBus, emitOutboxSchema } from "./emit_events";
import { emitBatchExecutor } from "./emit_batch";
import { emitSourceMapFile, emitDebugHandler } from "./emit_sourcemap";
import { emitTestSuite } from "./emit_tests";
import { emitDockerfile, emitDockerignore, emitK8sDeployment, emitGithubActions } from "./emit_deploy";
import { emitOpenApiSpec } from "./emit_openapi";
import { emitTypescriptSdk } from "./emit_sdk";
import { emitReactHooks } from "./emit_react";
import { emitZodSchemas } from "./emit_zod";
import { emitPostmanCollection } from "./emit_postman";
import { emitSeedFile } from "./emit_seed";
import { emitAuditSchema, emitAuditMiddleware } from "./emit_audit";
import { emitAdminPanel } from "./emit_admin";
import { emitNotifyService } from "./emit_notify";
import { emitCronJobs } from "./emit_cron";
import { emitGraphQLSchema } from "./emit_graphql";
import { emitProviders } from "./emit_provider";
import { emitCognitionFiles } from "./emit_cognition";
import { emitBudget } from "./emit_budget";
import { emitCacheFiles } from "./emit_cache";
import { emitMemoryFiles } from "./emit_memory";
import { emitIngestFiles } from "./emit_ingest";
import { emitValidateFile } from "./emit_validate";
import { emitRepairFile } from "./emit_repair";
import { emitTraceFiles } from "./emit_traces";
import { emitEvaluationFiles } from "./emit_evaluation";
import { emitCheckpointFiles } from "./emit_checkpoint";
import { emitBudgetFiles } from "./emit_budget_runtime";

function toSnakeCase(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

export interface FullEmitterOptions {
  noSdk?: boolean;
  noOpenApi?: boolean;
  noSeed?: boolean;
}

export class FullEmitter {
  private schemaEmitter = new Emitter();

  emit(system: IR.IRSystem, options: FullEmitterOptions = {}): EmittedFile[] {
    const files: EmittedFile[] = [];

    // 1. Package files
    files.push({ path: "package.json", content: emitPackageJson(system), language: "json", source_module: "root" });
    files.push({ path: "tsconfig.json", content: emitTsConfig(), language: "json", source_module: "root" });
    files.push({ path: ".env.example", content: this.emitEnvExample(system), language: "yaml", source_module: "root" });

    // 2. Source: infrastructure
    files.push({ path: "src/db.ts", content: emitDbClient(system), language: "typescript", source_module: "infra" });
    // Durable event bus replaces the old in-process stub
    files.push({ path: "src/events.ts", content: emitDurableEventBus(system), language: "typescript", source_module: "infra" });
    // Outbox SQL schema
    files.push({ path: "migrations/event_outbox.sql", content: emitOutboxSchema(), language: "sql", source_module: "infra" });
    files.push({ path: "src/auth.ts", content: emitAuthMiddleware(system), language: "typescript", source_module: "infra" });
    files.push({ path: "src/logger.ts", content: emitLogger(system), language: "typescript", source_module: "infra" });
    files.push({ path: "src/metrics.ts", content: emitMetrics(), language: "typescript", source_module: "infra" });
    files.push({ path: "src/health.ts", content: emitHealthChecks(system), language: "typescript", source_module: "infra" });
    files.push({ path: "src/failure_rules.ts", content: emitFailureRules(system), language: "typescript", source_module: "infra" });

    // 2a. WebSocket server (only if there are realtime channels)
    const wsContent = emitWebSocketServer(system);
    if (wsContent) {
      files.push({ path: "src/websocket.ts", content: wsContent, language: "typescript", source_module: "infra" });
    }

    // 2b. Flow saga runtime (only if there are flows)
    const flowContent = emitFlowRuntime(system);
    if (flowContent) {
      files.push({ path: "src/flows.ts", content: flowContent, language: "typescript", source_module: "infra" });
    }

    // 2b2. Batch executor (only if there are batch capabilities)
    const batchContent = emitBatchExecutor(system);
    if (batchContent) {
      files.push({ path: "src/batch.ts", content: batchContent, language: "typescript", source_module: "infra" });
    }

    // 2c. Migration diff utility (always emitted)
    files.push({ path: "src/migration_diff.ts", content: emitMigrationDiff(), language: "typescript", source_module: "infra" });

    // 2d. Algorithm implementations (only what's used)
    const usedAlgorithms = collectUsedAlgorithms(system);
    if (usedAlgorithms.size > 0) {
      const algoContent = emitAlgorithmsFile(usedAlgorithms);
      files.push({ path: "src/algorithms.ts", content: algoContent, language: "typescript", source_module: "algorithms" });
    } else {
      files.push({
        path: "src/algorithms.ts",
        content: "// No algorithms used in this system.\nexport {};\n",
        language: "typescript",
        source_module: "algorithms",
      });
    }

    // 2e. Extension points (escape hatches — preserved across recompilation)
    if (system.extension_points && system.extension_points.length > 0) {
      const extLines: string[] = [
        "// Generated by MarrowScript compiler.",
        "// Extension points: implement the functions below.",
        "// Code between sentinel comments is preserved on recompile.",
        "// DO NOT remove the sentinel comments.",
        "",
      ];
      // Map an IR type string (e.g. "uint", "list<string>", "optional<uuid>") to
      // a TypeScript type. Without this the stub file won't compile when
      // extension_point params use uint / int / float / etc.
      const irToTs = (irType: string): string => {
        const m: Record<string, string> = {
          string: "string", uint: "number", int: "number", float: "number",
          bool: "boolean", timestamp: "Date", uuid: "string", bytes: "Buffer", json: "unknown",
        };
        if (m[irType]) return m[irType];
        const list = irType.match(/^list<(.+)>$/); if (list) return `${irToTs(list[1])}[]`;
        const set = irType.match(/^set<(.+)>$/); if (set) return `${irToTs(set[1])}[]`;
        const opt = irType.match(/^optional<(.+)>$/); if (opt) return `${irToTs(opt[1])} | null`;
        // Entity ref or unknown — leave as-is so user-defined types resolve.
        return irType;
      };
      for (const ep of system.extension_points) {
        const params = ep.params.map((p: { name: string; type: string }) => `${p.name}: ${irToTs(p.type)}`).join(", ");
        const returnType = ep.returns ? irToTs(ep.returns) : "void";
        extLines.push(`/**`);
        extLines.push(` * Extension point: ${ep.name}`);
        extLines.push(` * ${ep.stable ? "STABLE: implementation required." : "Optional."}`);
        extLines.push(` */`);
        extLines.push(`export function ${ep.name}(${params}): ${returnType} {`);
        extLines.push(`  // <marrowscript:ext:${ep.name}:begin>`);
        extLines.push(`  throw new Error("Not implemented: ${ep.name}");`);
        extLines.push(`  // <marrowscript:ext:${ep.name}:end>`);
        extLines.push(`}`);
        extLines.push("");
      }
      files.push({
        path: "src/extensions.ts",
        content: extLines.join("\n"),
        language: "typescript",
        source_module: "extensions",
      });
    }

    // 3. Source: state machines
    for (const mod of system.modules) {
      for (const sm of mod.state_machines) {
        files.push({
          path: `src/state_machines/${toSnakeCase(sm.entity)}.ts`,
          content: emitStateMachineRuntime(sm),
          language: "typescript",
          source_module: mod.id,
        });
      }
    }

    // 4. Source: route files (CRUD + capabilities)
    for (const mod of system.modules) {
      if (mod.kind === "api_service" && mod.models.length > 0) {
        const content = emitEntityRouter(mod, system);
        if (content) {
          files.push({
            path: `src/routes/${toSnakeCase(mod.models[0].name)}.ts`,
            content,
            language: "typescript",
            source_module: mod.id,
          });
        }
      }
    }

    // 5. Source: main entry point
    files.push({ path: "src/index.ts", content: emitIndex(system), language: "typescript", source_module: "root" });

    // 6. SQL migrations — run schema emitter ONCE, then match by model name.
    // Multiple modules (e.g. an api_service AND its backing data_store) can
    // reference the same model. We dedupe by output path so each table only
    // appears once in migrations/ and once in the migrate.ts blocks list.
    const schemas: string[] = [];
    const seenPaths = new Set<string>();
    const allSchemaFiles = this.schemaEmitter.emit(system);
    for (const mod of system.modules) {
      if (mod.kind === "data_store" || mod.kind === "api_service") {
        for (const model of mod.models) {
          const schemaFile = allSchemaFiles.find(f => f.path.includes(toSnakeCase(model.name)) && f.language === "sql");
          if (schemaFile) {
            const targetPath = `migrations/${schemaFile.path.replace("schema/", "")}`;
            if (seenPaths.has(targetPath)) continue;
            seenPaths.add(targetPath);
            files.push({ ...schemaFile, path: targetPath });
            schemas.push(schemaFile.content);
          }
        }
      }
    }

    // 7. Migration runner
    files.push({ path: "src/migrate.ts", content: emitMigration(system, schemas), language: "typescript", source_module: "infra" });

    // 8. Docker compose for local dev
    files.push({ path: "docker-compose.yaml", content: this.emitDockerCompose(system), language: "yaml", source_module: "infra" });

    // 9. README
    files.push({ path: "README.md", content: this.emitReadme(system), language: "yaml", source_module: "root" });

    // 12. OpenAPI spec
    if (!options.noOpenApi) {
      files.push({ path: "openapi.yaml", content: emitOpenApiSpec(system), language: "yaml", source_module: "docs" });
      // GraphQL schema (alongside openapi)
      files.push({ path: "schema.graphql", content: emitGraphQLSchema(system), language: "yaml", source_module: "docs" });
    }

    // 13. TypeScript SDK
    if (!options.noSdk) {
      files.push({ path: "sdk/client.ts", content: emitTypescriptSdk(system), language: "typescript", source_module: "sdk" });
      // React hooks layered on top of the SDK
      files.push(emitReactHooks(system));
    }

    // 14. Zod schemas
    files.push({ path: "src/schemas.ts", content: emitZodSchemas(system), language: "typescript", source_module: "validation" });

    // 15. Postman collection
    if (!options.noOpenApi) {
      files.push({ path: `${system.name}.postman_collection.json`, content: emitPostmanCollection(system), language: "json", source_module: "docs" });
    }

    // 16. Seed file
    if (!options.noSeed) {
      files.push({ path: "src/seed.ts", content: emitSeedFile(system), language: "typescript", source_module: "dev" });
    }

    // 17. Audit log
    files.push({ path: "migrations/audit_log.sql", content: emitAuditSchema(), language: "sql", source_module: "infra" });
    files.push({ path: "src/audit.ts", content: emitAuditMiddleware(system), language: "typescript", source_module: "infra" });

    // 18. Notification service
    files.push({ path: "src/notify.ts", content: emitNotifyService(system), language: "typescript", source_module: "infra" });

    // 19. Cron jobs
    files.push({ path: "src/cron.ts", content: emitCronJobs(system), language: "typescript", source_module: "infra" });

    // ── Cognition Layer (LLM Harness, Phase 2) ─────────────────────────────
    // Provider adapters and the cognition runtime are emitted only when the
    // .marrow source declares any model / prompt / router / cognition: usage.
    // Existing non-cognition projects get zero new files.
    for (const f of emitProviders(system)) files.push(f);
    // Phase 3: budget tracker (emitted alongside cognition layer).
    const budgetFile = emitBudget(system);
    if (budgetFile) files.push(budgetFile);
    // Phase 3: prompt cache schema + runtime (only when at least one prompt
    // declares cache:).
    for (const f of emitCacheFiles(system)) files.push(f);
    // Phase 4: graph-based memory layer (only when a capability uses the
    // semantic_slice or compress_context cognition primitive).
    for (const f of emitMemoryFiles(system)) files.push(f);
    // Phase 9: repository ingestion (only when a capability uses the
    // ingest_repository cognition primitive).
    for (const f of emitIngestFiles(system)) files.push(f);
    // Phase 5: validation runtime + per-prompt repair functions.
    const validateFile = emitValidateFile(system);
    if (validateFile) files.push(validateFile);
    const repairFile = emitRepairFile(system);
    if (repairFile) files.push(repairFile);
    // Phase 6: cognition traces — durable span writer + OTLP exporter.
    for (const f of emitTraceFiles(system)) files.push(f);
    for (const f of emitCognitionFiles(system)) files.push(f);
    // Phase 16: typed regression tests for prompts. Only emits files when
    // at least one evaluation is declared in the system.
    for (const f of emitEvaluationFiles(system)) files.push(f);
    // Phase 17: human-in-the-loop checkpoint primitive. Only emits files
    // when at least one flow declares a checkpoint clause.
    for (const f of emitCheckpointFiles(system)) files.push(f);
    // Phase 21: cost budgets — multi-tenant quota enforcement. Only emits
    // files when at least one policy declares a cost_budget.
    for (const f of emitBudgetFiles(system)) files.push(f);

    // 18. Admin panel
    files.push({ path: "admin/index.html", content: emitAdminPanel(system), language: "yaml", source_module: "admin" });

    // 10. Source map + debug handler
    files.push({ path: `${system.name}.marrow.map`, content: emitSourceMapFile(system, `${system.name}.marrow`), language: "json", source_module: "root" });
    files.push({ path: "src/debug.ts", content: emitDebugHandler(system), language: "typescript", source_module: "infra" });
    files.push({ path: "src/tests.ts", content: emitTestSuite(system), language: "typescript", source_module: "tests" });

    // 10b. Dev-time token mint helper. Frontends running locally need a JWT
    //      that the auth middleware accepts. This script reads JWT_SECRET
    //      from .env, signs an HS256 token with `sub` and 24h expiry, and
    //      prints it. Trivial wrapper, but it removes the "how do I get a
    //      token to test the API?" friction for first-time frontend devs.
    files.push({
      path: "bin/mint_dev_token.ts",
      content: emitDevTokenScript(),
      language: "typescript",
      source_module: "infra",
    });

    // 11. Deploy targets
    files.push({ path: "Dockerfile", content: emitDockerfile(system), language: "yaml", source_module: "deploy" });
    files.push({ path: ".dockerignore", content: emitDockerignore(), language: "yaml", source_module: "deploy" });
    files.push({ path: "k8s/deployment.yaml", content: emitK8sDeployment(system), language: "yaml", source_module: "deploy" });
    files.push({ path: ".github/workflows/ci.yaml", content: emitGithubActions(system), language: "yaml", source_module: "deploy" });

    return files;
  }

  private emitEnvExample(system: IR.IRSystem): string {
    const baseLines = `# ${system.name} Environment Variables
# Copy this file to .env and fill in real values. Never commit .env to source control.

# --- Required in production ---
# Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=

# --- Database ---
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/${toSnakeCase(system.name)}

# --- Redis (optional, used by some domain templates) ---
REDIS_URL=redis://localhost:6379

# --- Server ---
PORT=3000
NODE_ENV=development

# --- CORS ---
# Comma-separated list of allowed origins. Leave empty to disallow all cross-origin requests.
# Common dev setups use one of:
#   ALLOWED_ORIGINS=http://localhost:5173                     (Vite default)
#   ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173  (Next.js + Vite together)
# Production: list the actual frontend domains.
#   ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000

# --- Event delivery mode ---
# in_process: in-memory, fast, no durability guarantees (default for development)
# durable: Postgres-backed transactional outbox (recommended for production)
EVENT_MODE=in_process
EVENT_WORKER_INTERVAL_MS=1000

# --- Request timeout ---
# Default 5 minutes — long enough for cognition pipelines (forge runs can
# legitimately take 30-60s on a slow free-tier provider, and we never want
# the request to time out before the LLM finishes). Override per-deployment.
REQUEST_TIMEOUT_MS=300000

# --- Notifications ---
# NOTIFY_PROVIDER=log|resend|sendgrid|webhook (default: log)
NOTIFY_PROVIDER=log
NOTIFY_API_KEY=
NOTIFY_FROM_EMAIL=noreply@example.com

# --- Webhook delivery (only when NOTIFY_PROVIDER=webhook) ---
# Endpoint that receives event payloads as application/json POST.
NOTIFY_WEBHOOK_URL=
# Optional HMAC-SHA256 secret. When set, requests include
# 'X-MarrowScript-Signature: <hex digest>' so receivers can verify integrity.
NOTIFY_WEBHOOK_SECRET=
`;

    // Only add cognition env vars when the system declares a harness surface.
    // Keeps existing non-cognition projects clean.
    const hasCognition =
      system.models.length > 0 ||
      system.prompts.length > 0 ||
      system.routers.length > 0;
    // Repository ingestion has its own env vars and can be used on its own
    // (a system can declare an `ingest_repository` capability without any
    // models). Detect that independently.
    const hasIngest = system.modules.some(m =>
      m.interfaces.some(i =>
        i.methods.some(meth => meth.cognition && meth.cognition.catalog_name === "ingest_repository")
      )
    );
    if (!hasCognition && !hasIngest) return baseLines;

    const cognitionLines = hasCognition ? `
# --- Cognition Layer (LLM Harness, Phase 2) ---
# Endpoint allowlist for openai_compat / http providers. Comma-separated URL
# prefixes. Loopback (127.0.0.0/8, ::1, localhost) and RFC1918 are allowed by
# default. Set LLM_ALLOW_PUBLIC_ENDPOINTS=1 to disable the host filter
# entirely (production only).
LLM_ENDPOINT_ALLOWLIST=
LLM_ALLOW_PUBLIC_ENDPOINTS=

# Per-trace and per-tenant token / cost budgets (Phase 3 will enforce; Phase 2
# emits the gauges only). Empty disables the gauge.
LLM_BUDGET_TOKENS_PER_TRACE=
LLM_BUDGET_USD_PER_TRACE=

# Provider-specific configuration.
# Ollama: defaults to http://127.0.0.1:11434.
OLLAMA_HOST=
# Optional bearer token for OpenAI-compatible endpoints (vLLM, LM Studio).
OPENAI_COMPAT_API_KEY=
` : "";

    const ingestLines = hasIngest ? `
# --- Repository ingestion (Phase 9) ---
# Where cloned repos are stored on disk. Default: ./.forge-cache/ingest/
LLM_INGEST_ROOT=
# Per-clone size ceiling in bytes (default 524288000 = 500 MB)
LLM_INGEST_MAX_BYTES=
# Per-clone file-count ceiling (default 50000)
LLM_INGEST_MAX_FILES=
# Per-clone timeout in milliseconds (default 120000 = 2 minutes)
LLM_INGEST_TIMEOUT_MS=
# Comma-separated URL prefixes that ingestRepository() is allowed to clone.
# Defaults to: https://github.com,https://gitlab.com,https://codeberg.org,https://bitbucket.org
# Set LLM_INGEST_ALLOW_ANY=1 to disable the host filter entirely (NOT recommended).
LLM_INGEST_ALLOWLIST=
LLM_INGEST_ALLOW_ANY=
` : "";

    return baseLines + cognitionLines + ingestLines;
  }

  private emitDockerCompose(system: IR.IRSystem): string {
    return `# Generated by MarrowScript compiler.
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${toSnakeCase(system.name)}
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
`;
  }

  private emitReadme(system: IR.IRSystem): string {
    const apiModules = system.modules.filter(m => m.kind === "api_service");
    const routes = apiModules
      .filter(m => m.models.length > 0)
      .map(m => `- \`/${toSnakeCase(m.models[0].name)}s\` Ã¢â‚¬â€ ${m.name}`)
      .join("\n");

    return `# ${system.name}

Generated by MarrowScript compiler. Source hash: ${system.source_hash}

## Quick Start

\`\`\`bash
# Start dependencies
docker compose up -d

# Install
npm install

# Run migrations
npm run migrate

# Start server
npm run dev
\`\`\`

## API Routes

${routes}

Each route supports:
- \`GET /\` Ã¢â‚¬â€ List (paginated)
- \`GET /:id\` Ã¢â‚¬â€ Read
- \`POST /\` Ã¢â‚¬â€ Create
- \`PUT /:id\` Ã¢â‚¬â€ Update
- \`DELETE /:id\` Ã¢â‚¬â€ Delete

Plus capability-specific endpoints.

## Auth

Send a Bearer token in the Authorization header:
\`\`\`
Authorization: Bearer <jwt-token>
\`\`\`

## Environment

Copy \`.env.example\` to \`.env\` and configure.
`;
  }
}

// ─── Dev token mint helper ───────────────────────────────────────────────────
//
// Emits a tiny `bin/mint_dev_token.ts` script that frontend devs run once to
// get a JWT they can paste into their dev tooling (Postman, fetch helpers,
// browser localStorage, etc). HS256 with the project's JWT_SECRET. The token
// is valid for 24h by default, overridable via --hours.
//
// Usage from inside the generated project:
//   npx ts-node bin/mint_dev_token.ts                     -> dev-user token, 24h
//   npx ts-node bin/mint_dev_token.ts --sub alice         -> sub=alice, 24h
//   npx ts-node bin/mint_dev_token.ts --sub alice --hours 1
//
// Production note: this script should NEVER be invoked in production. It's
// tagged as such in the file header. Real auth flows belong in the
// application's identity module (Cognito, Auth0, in-house OIDC, etc.).

function emitDevTokenScript(): string {
  return `// Generated by MarrowScript compiler. DO NOT EDIT.
// Dev-time JWT mint helper for frontend integration.
//
// This script ONLY exists for local dev. In production, tokens come from
// your real identity provider — never use this anywhere a human or service
// can hit it. The output token has \`sub\` set to whatever you pass via
// --sub (default: "dev-user") and expires after --hours hours (default 24).
//
// Usage:
//   npx ts-node bin/mint_dev_token.ts
//   npx ts-node bin/mint_dev_token.ts --sub alice
//   npx ts-node bin/mint_dev_token.ts --sub alice --hours 1
//
// Output is the raw JWT on stdout, suitable for piping:
//   export TOKEN=\\\`npx ts-node bin/mint_dev_token.ts --sub dev-user\\\`
//   curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/health/ready

require("dotenv").config();

import * as jwt from "jsonwebtoken";

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf("--" + name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const sub = arg("sub", "dev-user");
const hours = parseInt(arg("hours", "24"), 10);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error("[mint_dev_token] --hours must be a positive integer");
  process.exit(1);
}

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error("[mint_dev_token] JWT_SECRET is not set in .env. Set it and try again.");
  console.error("[mint_dev_token]   node -e \\"console.log(require('crypto').randomBytes(48).toString('hex'))\\"");
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  console.error("[mint_dev_token] Refusing to run in production (NODE_ENV=production).");
  process.exit(1);
}

const token = jwt.sign(
  { sub },
  secret,
  { algorithm: "HS256", expiresIn: hours + "h" },
);

// Print to stdout only — keeps shell capture clean.
process.stdout.write(token + "\\n");

if (process.env.MINT_DEV_TOKEN_VERBOSE === "1") {
  process.stderr.write("\\nMinted dev token:\\n");
  process.stderr.write("  sub:      " + sub + "\\n");
  process.stderr.write("  expires:  " + hours + "h from now\\n");
  process.stderr.write("  use it:   curl -H 'Authorization: Bearer " + token + "' <url>\\n");
}
`;
}
