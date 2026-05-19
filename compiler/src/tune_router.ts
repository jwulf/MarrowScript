/**
 * MarrowScript Router Tuner (LLM Harness, Phase 19 v2)
 *
 * Reads recorded cognition traces (the JSON shape `marrowc replay` writes)
 * and aggregates per-tier metrics for a router. Reports observed values
 * against the router's declared `policy:` constraints and surfaces:
 *
 *   - per-tier observed metrics (calls, validation_pass_rate, latency_p50,
 *     latency_p95, cost_usd_per_call, tokens_per_call, confidence_mean)
 *   - which tiers satisfy the declared constraints
 *   - which tiers violate them
 *   - a suggested re-tuning when the current tier ladder doesn't meet policy
 *
 * v2 is read-only — the tuner reports, the human edits the spec. Automatic
 * source rewrites are out of scope: too much risk of clobbering hand-tuned
 * fields, and the .marrow source is the source of truth.
 *
 * Determinism: aggregation walks spans in span_id order; tier results are
 * sorted by tier name; no Date.now()/Math.random() in this module. Two runs
 * over the same trace dump produce bitwise-identical reports.
 */

import * as IR from "./ir";

export interface TraceSpanLike {
  span_id?: string;
  trace_id?: string;
  workflow?: string;
  step?: string;
  kind?: string;
  prompt?: string | null;
  model?: string | null;
  status?: string;
  validate_result?: string | null;
  confidence?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_usd?: number | null;
  latency_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface TierMetrics {
  tier: string;
  /** Total prompt_call spans observed for this tier. */
  calls: number;
  /** Spans with status="ok". */
  ok_calls: number;
  /** Spans with status="validate_failed". */
  validate_failed: number;
  /** Spans with status="escalated" — these stayed bound to this tier. */
  escalated: number;
  /** validation_pass_rate = ok_calls / calls. NaN when calls=0. */
  validation_pass_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  cost_usd_per_call: number;
  tokens_per_call: number;
  /** Mean confidence over spans where confidence was recorded. */
  confidence_mean: number;
}

export interface ConstraintCheck {
  /** Original constraint expression as serialised in IR (e.g. "validation_pass_rate >= 0.9"). */
  expression: string;
  /** Metric being checked. */
  metric: string;
  /** Operator: >= | <= | > | < | ==. */
  op: string;
  /** Right-hand-side numeric literal. */
  threshold: number;
  /** Per-tier observed value (NaN when no data). */
  observed: { tier: string; value: number; passes: boolean }[];
}

export interface TuneReport {
  router: string;
  total_spans: number;
  prompt_call_spans: number;
  /** Tiers in declaration order. */
  tiers: TierMetrics[];
  /** Aggregated metrics across all tiers. */
  totals: { calls: number; ok_calls: number; total_cost_usd: number; total_tokens: number };
  /** Per-constraint pass/fail breakdown when policy is declared. */
  constraints: ConstraintCheck[];
  /** Suggested tier order if any constraint fails — see notes in suggestRetune(). */
  suggestions: string[];
}

/**
 * Compute per-tier metrics for a router from a span list. Spans not
 * belonging to the router (different prompt or workflow) are silently
 * filtered out — the caller passes whatever they have.
 */
export function tuneRouter(router: IR.IRRouter, spans: TraceSpanLike[]): TuneReport {
  // Sort spans so aggregation is order-stable. span_id is the natural key.
  const sorted = [...spans].sort((a, b) => (a.span_id || "").localeCompare(b.span_id || ""));

  const allSpans = sorted.length;
  const promptCallSpans = sorted.filter(s => s.kind === "prompt_call");

  // Group prompt_call spans by tier metadata. Spans with no recorded tier
  // (older traces, manually written fixtures) bucket under "unknown".
  const byTier = new Map<string, TraceSpanLike[]>();
  for (const s of promptCallSpans) {
    const tier = (s.metadata && typeof s.metadata.tier === "string") ? s.metadata.tier : "unknown";
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier)!.push(s);
  }

  // Render tiers in declaration order so the report mirrors the spec.
  // Append any "extra" tiers (recorded but not declared — usually "fallback"
  // or "fixed") at the end, sorted alphabetically for stability.
  const declared = router.tiers.map(t => t.name);
  const declaredSet = new Set(declared);
  const extra = [...byTier.keys()].filter(t => !declaredSet.has(t)).sort();
  const tierOrder = [...declared, ...extra];

  const tierMetrics: TierMetrics[] = [];
  for (const tier of tierOrder) {
    const spans = byTier.get(tier) ?? [];
    tierMetrics.push(computeTierMetrics(tier, spans));
  }

  const totals = {
    calls: promptCallSpans.length,
    ok_calls: promptCallSpans.filter(s => s.status === "ok").length,
    total_cost_usd: round6(promptCallSpans.reduce((acc, s) => acc + (s.cost_usd ?? 0), 0)),
    total_tokens: promptCallSpans.reduce((acc, s) => acc + (s.prompt_tokens ?? 0) + (s.completion_tokens ?? 0), 0),
  };

  // Evaluate the declared policy constraints (if any) against the
  // per-tier metrics.
  const constraints = router.policy
    ? router.policy.constraints.map(expr => evaluateConstraint(expr, tierMetrics))
    : [];

  const suggestions = suggestRetune(router, tierMetrics, constraints);

  return {
    router: router.name,
    total_spans: allSpans,
    prompt_call_spans: promptCallSpans.length,
    tiers: tierMetrics,
    totals,
    constraints,
    suggestions,
  };
}

function computeTierMetrics(tier: string, spans: TraceSpanLike[]): TierMetrics {
  const calls = spans.length;
  const ok = spans.filter(s => s.status === "ok").length;
  const validateFailed = spans.filter(s => s.status === "validate_failed").length;
  const escalated = spans.filter(s => s.status === "escalated").length;

  // Latency percentiles. Sort once, then index.
  const latencies = spans.map(s => s.latency_ms ?? 0).sort((a, b) => a - b);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);

  const totalCost = spans.reduce((acc, s) => acc + (s.cost_usd ?? 0), 0);
  const totalTokens = spans.reduce((acc, s) => acc + (s.prompt_tokens ?? 0) + (s.completion_tokens ?? 0), 0);

  const conf = spans
    .map(s => s.confidence)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const confMean = conf.length === 0 ? NaN : conf.reduce((a, b) => a + b, 0) / conf.length;

  return {
    tier,
    calls,
    ok_calls: ok,
    validate_failed: validateFailed,
    escalated,
    validation_pass_rate: calls === 0 ? NaN : ok / calls,
    latency_p50_ms: p50,
    latency_p95_ms: p95,
    cost_usd_per_call: calls === 0 ? NaN : round6(totalCost / calls),
    tokens_per_call: calls === 0 ? NaN : Math.round(totalTokens / calls),
    confidence_mean: confMean,
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Parse and evaluate a single constraint expression against per-tier metrics.
 * The expression shape is what `lowering.ts:serializeExpr` produces: e.g.
 *   "(validation_pass_rate >= 0.9)"
 *   "(latency_p95_ms <= 30000)"
 * We strip outer parens, split on the operator, and pull a metric name + a
 * numeric literal. Anything that doesn't match the simple shape becomes
 * an inconclusive entry in the report.
 */
function evaluateConstraint(expr: string, tiers: TierMetrics[]): ConstraintCheck {
  // Trim balanced wrapping parens.
  let trimmed = expr.trim();
  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    // Naive unwrap — the serialised forms always wrap once.
    const inner = trimmed.slice(1, -1).trim();
    trimmed = inner;
    if (!inner.includes(" ")) break; // safety
    if (!balancedAtRoot(inner)) {
      trimmed = "(" + inner + ")";
      break;
    }
  }

  // Match `<metric> <op> <number>`. Allow op variants in increasing length
  // first so >= matches before >.
  const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) {
    return { expression: expr, metric: "", op: "", threshold: NaN, observed: [] };
  }
  const [, metric, op, rhs] = m;
  const threshold = parseFloat(rhs);

  const observed = tiers.map(t => {
    const value = (t as unknown as Record<string, number>)[metric];
    const v = typeof value === "number" ? value : NaN;
    return { tier: t.tier, value: round6(v), passes: compareOp(v, op, threshold) };
  });
  return { expression: expr, metric, op, threshold, observed };
}

function compareOp(lhs: number, op: string, rhs: number): boolean {
  if (!Number.isFinite(lhs)) return false; // can't compare NaN/Inf — fail open
  switch (op) {
    case ">=": return lhs >= rhs;
    case "<=": return lhs <= rhs;
    case "==": return lhs === rhs;
    case ">":  return lhs > rhs;
    case "<":  return lhs < rhs;
  }
  return false;
}

function balancedAtRoot(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * When a constraint fails, surface a suggestion for the spec author. v2
 * suggestions are conservative: we don't try to compute new tier thresholds
 * (that's the optimisation problem proper), but we can spot the obvious
 * patterns.
 */
function suggestRetune(
  router: IR.IRRouter,
  tiers: TierMetrics[],
  constraints: ConstraintCheck[],
): string[] {
  const out: string[] = [];

  // Pattern 1: a constraint fails on a tier with low call volume.
  // Suggestion: not enough data to retune — collect more traces.
  for (const c of constraints) {
    for (const o of c.observed) {
      if (!o.passes) {
        const tm = tiers.find(t => t.tier === o.tier);
        if (tm && tm.calls < 30) {
          out.push(
            `${o.tier}: '${c.expression}' fails (${o.value} ${c.op} ${c.threshold}), but only ${tm.calls} call(s) recorded. Collect more traces before re-tuning.`,
          );
          continue;
        }
      }
    }
  }

  // Pattern 2: a tier consistently fails validation_pass_rate while a later
  // tier passes — suggestion: lower the upper-tier threshold so easy work
  // routes there too.
  const passRateConstraint = constraints.find(c => c.metric === "validation_pass_rate" && c.op === ">=");
  if (passRateConstraint) {
    const failing = passRateConstraint.observed.filter(o => !o.passes);
    const passing = passRateConstraint.observed.filter(o => o.passes);
    for (const f of failing) {
      const better = passing.find(p => {
        const ftier = router.tiers.find(t => t.name === f.tier);
        const ptier = router.tiers.find(t => t.name === p.tier);
        if (!ftier || !ptier) return false;
        // The "later" tier in the ladder has a larger max (or null = default).
        const fmax = ftier.max ?? Infinity;
        const pmax = ptier.max ?? Infinity;
        return pmax > fmax;
      });
      if (better) {
        out.push(
          `${f.tier}: validation_pass_rate=${f.value} < ${passRateConstraint.threshold}; consider lowering max on ${better.tier} so easy work routes through ${better.tier} (which observed ${better.value} pass rate).`,
        );
      }
    }
  }

  // Pattern 3: a tier passes everything cheaply — suggestion: raise its max
  // to capture more traffic. Only fires when the cheap tier observes >= 50
  // calls and meets every constraint.
  if (constraints.length > 0 && tiers.length > 1) {
    for (const t of tiers) {
      if (t.calls < 50) continue;
      const allPass = constraints.every(c => {
        const o = c.observed.find(x => x.tier === t.tier);
        return o ? o.passes : true;
      });
      if (allPass) {
        const tier = router.tiers.find(rt => rt.name === t.tier);
        if (tier && tier.max !== null) {
          out.push(
            `${t.tier}: meets all policy constraints over ${t.calls} calls; consider raising max above ${tier.max} to capture more traffic before escalating.`,
          );
        }
      }
    }
  }

  return out;
}

/**
 * Render a TuneReport as a human-readable string for the CLI.
 */
export function formatTuneReport(report: TuneReport): string {
  const lines: string[] = [];
  lines.push(`Router tune report: ${report.router}`);
  lines.push("=".repeat(60));
  lines.push(`Spans observed: ${report.total_spans} (${report.prompt_call_spans} prompt_call)`);
  lines.push(`Totals: ${report.totals.calls} calls, ${report.totals.ok_calls} ok, ${report.totals.total_tokens} tokens, $${report.totals.total_cost_usd.toFixed(4)}`);
  lines.push("");
  lines.push("Per-tier metrics:");
  for (const t of report.tiers) {
    lines.push(`  ${t.tier}:`);
    lines.push(`    calls=${t.calls}  ok=${t.ok_calls}  validate_failed=${t.validate_failed}  escalated=${t.escalated}`);
    if (t.calls > 0) {
      lines.push(`    pass_rate=${(t.validation_pass_rate * 100).toFixed(1)}%  p50=${t.latency_p50_ms}ms  p95=${t.latency_p95_ms}ms`);
      lines.push(`    cost/call=$${t.cost_usd_per_call.toFixed(6)}  tokens/call=${t.tokens_per_call}  confidence=${Number.isFinite(t.confidence_mean) ? t.confidence_mean.toFixed(3) : "n/a"}`);
    }
  }
  if (report.constraints.length > 0) {
    lines.push("");
    lines.push("Policy constraints:");
    for (const c of report.constraints) {
      lines.push(`  ${c.expression}`);
      for (const o of c.observed) {
        const sym = o.passes ? "v" : "x";
        lines.push(`    ${sym} ${o.tier}: ${Number.isFinite(o.value) ? o.value : "n/a"}`);
      }
    }
  }
  if (report.suggestions.length > 0) {
    lines.push("");
    lines.push("Suggestions:");
    for (const s of report.suggestions) lines.push(`  - ${s}`);
  }
  return lines.join("\n");
}
