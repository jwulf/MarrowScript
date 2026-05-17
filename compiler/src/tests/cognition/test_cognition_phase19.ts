/**
 * MarrowScript Cognition Phase 19 Tests — cost-aware routing
 *
 * Verifies:
 *   1. Lexer recognises observe + minimize_cost_subject_to keywords.
 *   2. Parser produces RouterDeclNode.observe + RouterDeclNode.policy.
 *   3. Lowering populates IRRouter.observe (string list) and IRRouter.policy
 *      with serialised constraint expressions.
 *   4. Type checker codes T070–T071:
 *        T070: unknown observe metric or unknown metric in policy constraint
 *        T071: policy references a metric that isn't observed
 *   5. Determinism — lowered IRRouter is stable across two compiles.
 */

import { Lexer, TokenKind } from "../lexer";
import { Parser } from "../parser";
import { TypeChecker } from "../typechecker";
import { Lowering } from "../lowering";

let passed = 0;
let failed = 0;

function ok(name: string): void { console.log(`  v ${name}`); passed++; }
function fail(name: string, msg: string): void { console.log(`  x ${name}: ${msg}`); failed++; }

function compile(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) throw new Error("type check: " + errs.map(e => e.code + ":" + e.message).join("; "));
  return new Lowering().lower(ast, "phase19-test")[0];
}
function tcheck(source: string) {
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  return new TypeChecker().check(ast);
}

console.log("MarrowScript Cognition Phase 19 Tests — cost-aware routing\n");

// ─── Section 1: lexer ──────────────────────────────────────────────────────

console.log("Section 1: Lexer recognises Phase 19 keywords");
{
  const src = "observe minimize_cost_subject_to";
  const tokens = new Lexer(src).tokenize();
  if (tokens.some(t => t.kind === TokenKind.KwObserve && t.value === "observe")) ok("lexer: 'observe' → KwObserve");
  else fail("lexer observe", "missing");
  if (tokens.some(t => t.kind === TokenKind.KwMinimizeCostSubjectTo && t.value === "minimize_cost_subject_to")) {
    ok("lexer: 'minimize_cost_subject_to' → KwMinimizeCostSubjectTo");
  } else {
    fail("lexer policy keyword", "missing");
  }
}

// ─── Section 2: parser + lowering ─────────────────────────────────────────

console.log("\nSection 2: Parser + lowering build the IR");

const phase19System = compile(`
  system Phase19 {
    model Tiny {
      provider: ollama
      name: "qwen2.5:1.5b"
      context_window: 8000
      max_output: 256
      cost_class: tiny
    }
    model Medium {
      provider: openai_compat
      endpoint: "http://localhost:8080/v1"
      name: "phi-3.5"
      context_window: 32000
      max_output: 1024
      cost_class: medium
    }
    router smart_router {
      by: input.complexity
      observe: ["validation_pass_rate", "latency_p95_ms", "cost_usd_per_call"]
      tier easy { max: 0.6 -> Tiny }
      tier hard { -> Medium }
      policy: minimize_cost_subject_to {
        validation_pass_rate >= 0.9
        latency_p95_ms <= 30000
      }
      fallback: Medium
    }
  }
`);

{
  const router = phase19System.routers[0];
  if (router && router.observe.length === 3) ok("IR: 3 observed metrics");
  else fail("observe count", String(router?.observe?.length));

  if (router && router.observe.includes("validation_pass_rate") &&
      router.observe.includes("latency_p95_ms") &&
      router.observe.includes("cost_usd_per_call")) {
    ok("IR: observe list preserved");
  } else {
    fail("observe values", JSON.stringify(router?.observe));
  }

  if (router && router.policy && router.policy.objective === "minimize_cost_subject_to") {
    ok("IR: policy.objective=minimize_cost_subject_to");
  } else {
    fail("policy objective", JSON.stringify(router?.policy));
  }

  if (router && router.policy && router.policy.constraints.length === 2) {
    ok("IR: 2 policy constraints");
  } else {
    fail("constraint count", String(router?.policy?.constraints?.length));
  }

  // Constraint expressions are serialised; each should mention its metric.
  if (router && router.policy &&
      router.policy.constraints.some(c => c.includes("validation_pass_rate")) &&
      router.policy.constraints.some(c => c.includes("latency_p95_ms"))) {
    ok("IR: constraints reference both metrics");
  } else {
    fail("constraints serialise", JSON.stringify(router?.policy?.constraints));
  }
}

// ─── Section 3: type checker T070..T071 ───────────────────────────────────

console.log("\nSection 3: TypeChecker — T070..T071");

function expectErr(name: string, code: string, source: string): void {
  const errs = tcheck(source);
  if (errs.some(e => e.code === code)) ok(`${code}: ${name}`);
  else fail(name, `expected ${code}, got [${errs.map(e => e.code).join(", ")}]`);
}

// T070: unknown observe metric.
expectErr("unknown observe metric", "T070", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    router r {
      by: input.x
      observe: ["nonsense_metric"]
      tier a { -> M }
    }
  }
`);

// T070: unknown metric in policy constraint.
expectErr("unknown metric in constraint", "T070", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    router r {
      by: input.x
      observe: ["validation_pass_rate"]
      tier a { -> M }
      policy: minimize_cost_subject_to {
        garbage_metric >= 0.5
      }
    }
  }
`);

// T071: constraint references metric not observed.
expectErr("constraint references unobserved metric", "T071", `
  system X {
    model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
    router r {
      by: input.x
      observe: ["validation_pass_rate"]
      tier a { -> M }
      policy: minimize_cost_subject_to {
        latency_p95_ms <= 30000
      }
    }
  }
`);

// ─── Section 4: backward compat ──────────────────────────────────────────

console.log("\nSection 4: routers without observe/policy still work");
{
  const sys = compile(`
    system NoP {
      model M { provider: ollama, name: "x", context_window: 8000, max_output: 256, cost_class: tiny }
      router r {
        by: input.x
        tier a { -> M }
      }
    }
  `);
  const r = sys.routers[0];
  if (r.observe.length === 0 && r.policy === null) ok("legacy router: observe=[], policy=null");
  else fail("legacy", JSON.stringify({ observe: r.observe, policy: r.policy }));
}

// ─── Section 5: determinism ─────────────────────────────────────────────

console.log("\nSection 5: determinism");
{
  const a = JSON.stringify(phase19System.routers);
  const b = JSON.stringify(compile(`
    system Phase19 {
      model Tiny {
        provider: ollama
        name: "qwen2.5:1.5b"
        context_window: 8000
        max_output: 256
        cost_class: tiny
      }
      model Medium {
        provider: openai_compat
        endpoint: "http://localhost:8080/v1"
        name: "phi-3.5"
        context_window: 32000
        max_output: 1024
        cost_class: medium
      }
      router smart_router {
        by: input.complexity
        observe: ["validation_pass_rate", "latency_p95_ms", "cost_usd_per_call"]
        tier easy { max: 0.6 -> Tiny }
        tier hard { -> Medium }
        policy: minimize_cost_subject_to {
          validation_pass_rate >= 0.9
          latency_p95_ms <= 30000
        }
        fallback: Medium
      }
    }
  `).routers);
  if (a === b) ok("router IR: deterministic across two compiles");
  else fail("determinism", "differ");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 19 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
