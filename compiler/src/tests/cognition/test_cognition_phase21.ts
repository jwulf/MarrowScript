/**
 * MarrowScript Cognition Phase 21 Tests — cost_budget primitive
 *
 * Verifies:
 *   1. Lexer recognises new tokens: cost_budgets, scope, window, cap_usd,
 *      cap_tokens, cap_calls, on_exceeded, action, retry_after, throttle,
 *      per_tenant, per_user, per_feature, code, error.
 *   2. Parser produces PolicyDeclNode.costBudgets with the right shape:
 *      scope, feature (when per_feature), window, exactly-one cap, action,
 *      retry_after / code (when applicable).
 *   3. Lowering populates IRSystem.cost_budgets with stable IDs, ms-converted
 *      windows + retry_after, and preserved cap kind.
 *   4. Type checker codes T050–T054:
 *        T050: zero or multiple caps
 *        T051: per_feature scope without feature, or referencing undeclared capability
 *        T052: action=throttle without retry_after
 *        T053: window must be > 0
 *        T054: cap values must be > 0
 *   5. emitBudgetFiles produces 3 files when cost_budgets are declared,
 *      and 0 otherwise:
 *        migrations/budget_counters.sql
 *        src/policy/budgets.ts
 *        src/routes/admin_budgets.ts
 *   6. Runtime exports the documented API: BudgetExceededError, BudgetThrottleError,
 *      BUDGETS, assertWithinBudget, chargeBudget, getBudgetState, resetBudgetForScope.
 *   7. Determinism — emit is bitwise stable across two runs.
 */

import { Lexer, TokenKind } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";
import { emitBudgetFiles, budgetsNeeded } from "../emit_budget_runtime";

let passed = 0;
let failed = 0;

function ok(name: string): void { console.log(`  v ${name}`); passed++; }
function fail(name: string, msg: string): void { console.log(`  x ${name}: ${msg}`); failed++; }

function compile(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) throw new Error("type check: " + errs.map(e => e.code + ":" + e.message).join("; "));
  return new Lowering().lower(ast, "phase21-test")[0];
}
function tcheck(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  return new TypeChecker().check(ast);
}

console.log("MarrowScript Cognition Phase 21 Tests — cost budgets\n");

// ─── Section 1: lexer ───────────────────────────────────────────────────────

console.log("Section 1: Lexer recognises Phase 21 keywords");
{
  // Note: scope, window, action, code, error are NOT reserved keywords —
  // they're contextual field names parsed inside cost_budget bodies. Only
  // the ones that don't collide with user identifiers are real tokens.
  const src = "cost_budgets cap_usd cap_tokens cap_calls on_exceeded retry_after throttle per_tenant per_user per_feature";
  const tokens = new Lexer(src).tokenize();
  const checks: [string, TokenKind][] = [
    ["cost_budgets", TokenKind.KwCostBudgets],
    ["cap_usd", TokenKind.KwCapUsd],
    ["cap_tokens", TokenKind.KwCapTokens],
    ["cap_calls", TokenKind.KwCapCalls],
    ["on_exceeded", TokenKind.KwOnExceeded],
    ["retry_after", TokenKind.KwRetryAfter],
    ["throttle", TokenKind.KwThrottle],
    ["per_tenant", TokenKind.KwPerTenant],
    ["per_user", TokenKind.KwPerUser],
    ["per_feature", TokenKind.KwPerFeature],
  ];
  for (const [name, kind] of checks) {
    if (tokens.some(t => t.kind === kind && t.value === name)) ok(`lexer: '${name}' → ${kind}`);
    else fail(`lexer ${name}`, "missing");
  }
  // Contextual identifiers — should remain Identifier tokens.
  const ctxSrc = "scope window action code error";
  const ctxTokens = new Lexer(ctxSrc).tokenize();
  for (const word of ["scope", "window", "action", "code", "error"]) {
    const t = ctxTokens.find(t => t.value === word);
    if (t && t.kind === TokenKind.Identifier) ok(`lexer: '${word}' is contextual (Identifier, not reserved)`);
    else fail(`lexer ${word} contextual`, `expected Identifier, got ${t?.kind}`);
  }
}

// ─── Section 2: parsing + lowering ──────────────────────────────────────────

console.log("\nSection 2: Parser + lowering build the IR");

const phase21System = compile(`
  system Phase21 {
    entity Doc { owns: [body: string] }
    capability forge_artifact(d: Doc) {
      requires: [d.body != ""]
      sync: eventual
      idempotent: true
    }

    policy app_costs {
      rate_limit: 60 per 1m
      audit: true
      cost_budgets: [
        {
          scope: per_tenant
          window: 1d
          cap_usd: 5.0
          on_exceeded: { action: throttle, retry_after: 1h }
        },
        {
          scope: per_user
          window: 1h
          cap_tokens: 100000
          on_exceeded: { action: error, code: "DAILY_LIMIT" }
        },
        {
          scope: per_feature: "forge_artifact"
          window: 1h
          cap_calls: 10
          on_exceeded: { action: error }
        }
      ]
    }
  }
`);

{
  const budgets = phase21System.cost_budgets;
  if (budgets.length === 3) ok("IR: 3 cost_budgets lowered");
  else fail("budget count", String(budgets.length));

  const tenant = budgets.find(b => b.scope === "per_tenant");
  if (tenant && tenant.cap_usd === 5.0) ok("per_tenant: cap_usd=5.0");
  else fail("tenant cap", JSON.stringify(tenant));
  if (tenant && tenant.window_ms === 86_400_000) ok("per_tenant: window_ms=86400000 (1d)");
  else fail("tenant window", String(tenant?.window_ms));
  if (tenant && tenant.action === "throttle" && tenant.retry_after_ms === 3_600_000) {
    ok("per_tenant: throttle + retry_after_ms=3600000 (1h)");
  } else {
    fail("tenant throttle", JSON.stringify({ action: tenant?.action, retry: tenant?.retry_after_ms }));
  }

  const user = budgets.find(b => b.scope === "per_user");
  if (user && user.cap_tokens === 100_000 && user.error_code === "DAILY_LIMIT") {
    ok("per_user: cap_tokens=100000 + error_code=DAILY_LIMIT");
  } else {
    fail("user budget", JSON.stringify(user));
  }

  const feature = budgets.find(b => b.scope === "per_feature");
  if (feature && feature.feature === "forge_artifact" && feature.cap_calls === 10) {
    ok("per_feature: feature=forge_artifact, cap_calls=10");
  } else {
    fail("feature budget", JSON.stringify(feature));
  }

  // Deterministic ID shape — must be stable across runs.
  if (tenant && tenant.id.startsWith("app_costs:per_tenant:")) ok("IR: id derived from policy + scope");
  else fail("id shape", tenant?.id ?? "missing");
}

// ─── Section 3: type-checker T050..T054 ────────────────────────────────────

console.log("\nSection 3: TypeChecker — T050..T054 negative cases");

function expectErr(name: string, code: string, source: string): void {
  const errs = tcheck(source);
  if (errs.some(e => e.code === code)) ok(`${code}: ${name}`);
  else fail(name, `expected ${code}, got [${errs.map(e => e.code).join(", ")}]`);
}

// T050: zero caps
expectErr("zero caps", "T050", `
  system X {
    policy p {
      cost_budgets: [{ scope: per_tenant, window: 1d, on_exceeded: { action: error } }]
    }
  }
`);

// T050: multiple caps
expectErr("multiple caps", "T050", `
  system X {
    policy p {
      cost_budgets: [{ scope: per_user, window: 1h, cap_usd: 1.0, cap_tokens: 100, on_exceeded: { action: error } }]
    }
  }
`);

// T051: per_feature without a known capability
expectErr("per_feature undeclared capability", "T051", `
  system X {
    policy p {
      cost_budgets: [{ scope: per_feature: "ghost", window: 1h, cap_calls: 5, on_exceeded: { action: error } }]
    }
  }
`);

// T052: throttle without retry_after
expectErr("throttle without retry_after", "T052", `
  system X {
    policy p {
      cost_budgets: [{ scope: per_tenant, window: 1d, cap_usd: 5.0, on_exceeded: { action: throttle } }]
    }
  }
`);

// T053: window=0
expectErr("window 0s", "T053", `
  system X {
    policy p {
      cost_budgets: [{ scope: per_user, window: 0s, cap_calls: 5, on_exceeded: { action: error } }]
    }
  }
`);

// T054: cap_calls=0
expectErr("cap_calls=0", "T054", `
  system X {
    policy p {
      cost_budgets: [{ scope: per_user, window: 1h, cap_calls: 0, on_exceeded: { action: error } }]
    }
  }
`);

// ─── Section 4: file emission ──────────────────────────────────────────────

console.log("\nSection 4: emitBudgetFiles produces 3 files");

{
  if (budgetsNeeded(phase21System)) ok("budgetsNeeded: true when budgets declared");
  else fail("needed", "expected true");

  const files = emitBudgetFiles(phase21System);
  const paths = files.map(f => f.path).sort();
  const expected = ["migrations/budget_counters.sql", "src/policy/budgets.ts", "src/routes/admin_budgets.ts"];
  if (JSON.stringify(paths) === JSON.stringify(expected)) ok("emitBudgetFiles: 3-file tree");
  else fail("paths", JSON.stringify(paths));

  const sql = files.find(f => f.path === "migrations/budget_counters.sql")!;
  for (const tbl of ["CREATE TABLE IF NOT EXISTS budget_counters", "CREATE TABLE IF NOT EXISTS budget_events"]) {
    if (sql.content.includes(tbl)) ok(`sql: ${tbl}`);
    else fail(tbl, "missing");
  }
  if (sql.content.includes("PRIMARY KEY (budget_id, scope_value, window_start)")) {
    ok("sql: composite primary key on counters");
  } else {
    fail("counter PK", "missing");
  }
  if (sql.content.includes("cost_usd_micros BIGINT")) ok("sql: cost stored as micros (no float drift)");
  else fail("micros", "missing");

  const runtime = files.find(f => f.path === "src/policy/budgets.ts")!;
  for (const exp of [
    "export class BudgetExceededError",
    "export class BudgetThrottleError",
    "export const BUDGETS:",
    "export async function assertWithinBudget(",
    "export async function chargeBudget(",
    "export async function getBudgetState(",
    "export async function resetBudgetForScope(",
  ]) {
    if (runtime.content.includes(exp)) ok(`runtime: ${exp}`);
    else fail(exp, "missing");
  }

  // Embedded budget specs include the right scope/cap kind for each.
  if (runtime.content.includes(`"scope":"per_tenant"`) &&
      runtime.content.includes(`"scope":"per_user"`) &&
      runtime.content.includes(`"scope":"per_feature"`)) {
    ok("runtime: BUDGETS contains all three scopes");
  } else {
    fail("BUDGETS specs", "missing one or more scopes");
  }

  // Atomic counter increment via INSERT ... ON CONFLICT.
  if (runtime.content.includes("ON CONFLICT (budget_id, scope_value, window_start)")) {
    ok("runtime: atomic increment via ON CONFLICT");
  } else {
    fail("ON CONFLICT", "missing");
  }

  // Sliding-window math.
  if (runtime.content.includes("function windowStart(")) ok("runtime: windowStart() helper");
  else fail("windowStart", "missing");

  const route = files.find(f => f.path === "src/routes/admin_budgets.ts")!;
  if (route.content.includes(`adminBudgetsRouter.get("/:tenant_id?"`) &&
      route.content.includes(`adminBudgetsRouter.post("/:scope_value/reset"`)) {
    ok("route: GET tenant + POST reset endpoints");
  } else {
    fail("admin route", "endpoints missing");
  }
}

// ─── Section 5: skipped when no budgets ────────────────────────────────────

console.log("\nSection 5: zero budgets → zero files");

{
  const noB = compile(`
    system NoBudget {
      entity D { owns: [b: string] }
      policy p {
        rate_limit: 10 per 1m
        audit: true
      }
    }
  `);
  if (!budgetsNeeded(noB)) ok("budgetsNeeded: false when no budgets");
  else fail("needed false", "expected false");
  const files = emitBudgetFiles(noB);
  if (files.length === 0) ok("emitBudgetFiles: zero files");
  else fail("files", String(files.length));
}

// ─── Section 6: determinism ────────────────────────────────────────────────

console.log("\nSection 6: emitBudgetFiles is deterministic");

{
  const a = emitBudgetFiles(phase21System).map(f => f.path + ":" + f.content).join("\n");
  const b = emitBudgetFiles(phase21System).map(f => f.path + ":" + f.content).join("\n");
  if (a === b && a.length > 0) ok("emitBudgetFiles: bitwise identical across two runs");
  else fail("determinism", "differ");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 21 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
