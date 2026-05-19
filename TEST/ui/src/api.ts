// MarrowForge API client. Talks to the generated backend at /api (proxied to
// http://localhost:3000 in dev via vite.config.ts). All requests are JSON
// over HTTP with a Bearer token in the Authorization header.
//
// The shapes here mirror the typed SDK the compiler emits at
// TEST/output/sdk/client.ts — kept in sync by hand for the UI.

export type Preset =
  | "compat_layer"
  | "combine"
  | "bridge"
  | "port_a_to_b"
  | "port_b_to_a"
  | "extract"
  | "compare_apis";

export const PRESETS: Array<{ id: Preset; name: string; desc: string; complexity: number }> = [
  { id: "compare_apis", name: "Compare APIs",     desc: "Diff the two repos and produce a markdown report. No codegen.", complexity: 0.4 },
  { id: "compat_layer", name: "Compat layer",     desc: "Build a typed adapter exposing A's surface in B's idioms.",     complexity: 0.65 },
  { id: "bridge",       name: "Event bridge",     desc: "Wire A's events into B's input handlers as glue code.",         complexity: 0.7 },
  { id: "extract",      name: "Extract module",   desc: "Pull a subsystem from A and graft it into B as a new module.",  complexity: 0.7 },
  { id: "combine",      name: "Combine",          desc: "Merge A and B into a new unified module exposing both.",        complexity: 0.85 },
  { id: "port_a_to_b",  name: "Port A → B",       desc: "Reimplement A's surface using B's libraries / patterns.",       complexity: 0.85 },
  { id: "port_b_to_a",  name: "Port B → A",       desc: "Reverse direction — reimplement B in A's idioms.",              complexity: 0.85 },
];

export interface RepoForgeRequest {
  title: string;
  description: string;
  preset: Preset;
  repo_a_url: string;
  repo_a_ref: string;
  repo_b_url: string;
  repo_b_ref: string;
  target_path: string;
  complexity: number;
}

export interface RepoIngestSummary {
  url_redacted: string;
  ref: string;
  head_sha: string;
  file_count: number;
  total_bytes: number;
  cached: boolean;
}

export interface ForgeResponse {
  ok: boolean;
  action: string;
  trace_id: string | null;
  results: {
    repo_a: RepoIngestSummary;
    repo_b: RepoIngestSummary;
    analysis: string;
    /** Optional: present when the pipeline ran the TS-feasibility scoping
     *  pass. Contains a JSON string with feasibility / revised_plan /
     *  out_of_scope / caveats. Always present for codegen presets,
     *  absent for compare_apis / migrate which skip scoping. */
    scoped?: string;
    artifact: string;
  };
}

export interface CognitionSpan {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  workflow: string;
  step: string;
  kind: string;
  prompt: string | null;
  model: string | null;
  provider: string | null;
  validate_result: string | null;
  confidence: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  cache_hit: boolean;
  status: string;
  error_code: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface TraceResponse {
  trace_id: string;
  span_count: number;
  spans: CognitionSpan[];
}

export interface ApiError {
  code: string;
  message: string;
}

const BASE = "/api";
const TOKEN_KEY = "marrowforge_token";

// Token helpers — stored in localStorage so a refresh keeps the user signed in.
export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}
export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let detail: ApiError | null = null;
    try {
      const j = await res.json();
      detail = j?.error ?? null;
    } catch { /* not JSON */ }
    const msg = detail?.message ?? `${res.status} ${res.statusText}`;
    const err = new Error(msg) as Error & { code?: string; status?: number };
    err.code = detail?.code;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function checkHealth(): Promise<{ status: string }> {
  return request("GET", "/health/live");
}

export async function forgeFromRepos(req: RepoForgeRequest, signal?: AbortSignal): Promise<ForgeResponse> {
  return request("POST", "/repo_forge_requests/forge-from-repos", req, signal);
}

export async function getCognitionTrace(traceId: string): Promise<TraceResponse> {
  return request("GET", `/cognition_traces/${traceId}`);
}

// ─── Async forge runs (resilient to page refresh) ─────────────────────────

export type ForgeRunStatus = "running" | "done" | "error" | "cancelled";

export interface ForgeRunStep {
  name: string;
  state: "pending" | "running" | "done" | "error";
  started_at?: number;
  finished_at?: number;
  meta?: string;
}

export interface ForgeRunSnapshot {
  id: string;
  status: ForgeRunStatus;
  started_at: number;
  finished_at: number | null;
  request: Record<string, unknown>;
  trace_id: string | null;
  steps: ForgeRunStep[];
  result: ForgeResponse["results"] | null;
  error: string | null;
}

/** Start an async forge run. Returns immediately with a forge_id; the
 *  pipeline runs in the background. Poll with getForgeRun(id) until
 *  status leaves "running". */
export async function startForgeRun(req: RepoForgeRequest): Promise<{ forge_id: string }> {
  return request("POST", "/forge_runs/start", req);
}

/** Fetch the current state of an async forge run. */
export async function getForgeRun(id: string): Promise<ForgeRunSnapshot> {
  return request("GET", `/forge_runs/${id}`);
}

/** Cancel a running forge. */
export async function cancelForgeRun(id: string): Promise<{ ok: boolean; action: string }> {
  return request("DELETE", `/forge_runs/${id}`);
}
