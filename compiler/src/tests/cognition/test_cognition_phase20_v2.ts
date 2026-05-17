/**
 * MarrowScript Cognition Phase 20 v2 Tests — LLM-driven inference
 *
 * Uses a FakeProvider that returns scripted responses so the test is
 * deterministic and runs offline. The provider's behavior is verified
 * separately against the OpenAI-compat wire format.
 *
 * Verifies:
 *   1. Tool registry has the documented 5 tools with valid JSON Schemas.
 *   2. Tool implementations: list_directory, read_file, find_class,
 *      find_function, find_references all work on a fixture project.
 *   3. safeJoin rejects path traversal + absolute paths.
 *   4. runToolLoop dispatches tool calls and feeds results back to the model.
 *   5. runToolLoop respects maxToolCalls budget.
 *   6. parseLLMOutput extracts capabilities from various wrapping forms.
 *   7. parseLLMOutput drops malformed records.
 *   8. filterInferredCapabilities removes unknown entities + duplicates.
 *   9. emitEnrichedStub produces a valid .marrow source.
 *  10. End-to-end: reflectProjectWithLLM with FakeProvider produces the
 *      expected merged result.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  reflectProjectWithLLM,
  parseLLMOutput,
  emitEnrichedStub,
} from "../reflect_llm";
import { buildToolRegistry, safeJoin, specsFromRegistry } from "../reflect_llm/tools";
import { runToolLoop } from "../reflect_llm/llm";
import { filterInferredCapabilities } from "../reflect_llm/output";
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMProvider,
  ReflectionLLMResult,
} from "../reflect_llm/types";
import type { ReflectionResult } from "../reflect";

let passed = 0;
let failed = 0;

function ok(name: string): void { console.log(`  v ${name}`); passed++; }
function fail(name: string, msg: string): void { console.log(`  x ${name}: ${msg}`); failed++; }

console.log("MarrowScript Cognition Phase 20 v2 Tests — LLM-driven inference\n");

async function main() {

// ─── Fixture project on disk ───────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marrow-phase20v2-"));
const srcDir = path.join(tmpRoot, "src");
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, "user.ts"), `
export class User {
  id: string;
  email: string;
  name: string;
}

export function rename_user(u: User, name: string): void {
  if (name === "") throw new Error("name required");
  u.name = name;
}
`);
fs.writeFileSync(path.join(srcDir, "post.ts"), `
export interface Post {
  id: string;
  title: string;
  body: string;
}

export function publish_post(p: Post): void {
  // mark as published — left implicit
}
`);
// path-traversal target outside the project root
fs.mkdirSync(path.join(tmpRoot, "..", "marrow-phase20v2-outside"), { recursive: true });

// ─── Section 1: tool registry shape ───────────────────────────────────────

console.log("Section 1: tool registry shape");

{
  const reg = buildToolRegistry(tmpRoot);
  const names = Object.keys(reg).sort();
  const expected = ["find_class", "find_function", "find_references", "list_directory", "read_file"];
  if (JSON.stringify(names) === JSON.stringify(expected)) ok("registry: 5 tools (sorted)");
  else fail("registry names", JSON.stringify(names));

  const specs = specsFromRegistry(reg);
  if (specs.every(s => s.parameters && s.parameters.type === "object")) ok("specs: all have object parameters");
  else fail("spec shape", JSON.stringify(specs.map(s => s.name)));
}

// ─── Section 2: tool implementations ──────────────────────────────────────

console.log("\nSection 2: tool implementations");

{
  const reg = buildToolRegistry(tmpRoot);

  // list_directory
  const ls = await reg.list_directory.fn({ path: "." }) as { entries?: { name: string; type: string }[] };
  if (ls.entries && ls.entries.some(e => e.name === "src" && e.type === "dir")) ok("list_directory: finds src/");
  else fail("list_directory", JSON.stringify(ls));

  // read_file
  const rf = await reg.read_file.fn({ path: "src/user.ts" }) as { content?: string };
  if (rf.content && rf.content.includes("class User")) ok("read_file: reads user.ts");
  else fail("read_file", JSON.stringify(rf).slice(0, 200));

  // find_class
  const fc = await reg.find_class.fn({ name: "User" }) as { matches?: { kind: string; line: number }[] };
  if (fc.matches && fc.matches.length === 1 && fc.matches[0].kind === "class") ok("find_class: finds User class");
  else fail("find_class", JSON.stringify(fc));

  const fcInterface = await reg.find_class.fn({ name: "Post" }) as { matches?: { kind: string }[] };
  if (fcInterface.matches && fcInterface.matches[0].kind === "interface") ok("find_class: identifies Post as interface");
  else fail("find_class kind", JSON.stringify(fcInterface));

  // find_function
  const ff = await reg.find_function.fn({ name: "rename_user" }) as { matches?: { signature: string }[] };
  if (ff.matches && ff.matches[0].signature.includes("u: User") && ff.matches[0].signature.includes("name: string")) {
    ok("find_function: signature includes both params");
  } else {
    fail("find_function", JSON.stringify(ff));
  }

  // find_references
  const fr = await reg.find_references.fn({ symbol: "User" }) as { matches?: unknown[] };
  if (Array.isArray(fr.matches) && fr.matches.length >= 2) ok("find_references: finds multiple User references");
  else fail("find_references", JSON.stringify(fr));
}

// ─── Section 3: path safety ───────────────────────────────────────────────

console.log("\nSection 3: path safety");

{
  const reg = buildToolRegistry(tmpRoot);
  // safeJoin direct tests
  if (safeJoin(tmpRoot, "src/user.ts") !== null) ok("safeJoin: in-tree path resolves");
  else fail("safeJoin in-tree", "got null");
  if (safeJoin(tmpRoot, "../outside") === null) ok("safeJoin: rejects ..");
  else fail("safeJoin .. ", "did not reject");
  if (safeJoin(tmpRoot, "/etc/passwd") === null) ok("safeJoin: rejects absolute path");
  else fail("safeJoin abs", "did not reject");

  // Tool error path: read_file with traversal returns error JSON, not throws.
  const rf = await reg.read_file.fn({ path: "../../../../etc/passwd" }) as { error?: string };
  if (rf.error && rf.error.includes("outside project root")) ok("read_file: traversal returns error JSON");
  else fail("traversal", JSON.stringify(rf));
}

// ─── Section 4: tool-call loop with FakeProvider ─────────────────────────

console.log("\nSection 4: tool-call loop with FakeProvider");

class FakeProvider implements LLMProvider {
  private script: LLMChatResponse[];
  public called = 0;
  public lastTools?: { name: string }[];
  constructor(script: LLMChatResponse[]) { this.script = script; }
  async chat(req: LLMChatRequest): Promise<LLMChatResponse> {
    this.called++;
    this.lastTools = req.tools?.map(t => ({ name: t.name }));
    if (this.called > this.script.length) {
      throw new Error(`FakeProvider exhausted (call ${this.called}, script len ${this.script.length})`);
    }
    return this.script[this.called - 1];
  }
}

{
  // Provider returns a tool_call, then a final answer.
  const provider = new FakeProvider([
    {
      content: "",
      tool_calls: [{ id: "1", name: "list_directory", arguments: JSON.stringify({ path: "." }) }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    {
      content: '{"capabilities":[]}',
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    },
  ]);
  const reg = buildToolRegistry(tmpRoot);
  const calls: { name: string }[] = [];
  const result = await runToolLoop({
    provider,
    model: "fake-model",
    systemPrompt: "system",
    userPrompt: "user",
    tools: reg,
    maxToolCalls: 5,
    onToolCall: (c) => calls.push({ name: c.name }),
  });
  if (provider.called === 2) ok("loop: dispatched then re-prompted (2 chats)");
  else fail("loop chats", String(provider.called));
  if (calls.length === 1 && calls[0].name === "list_directory") ok("loop: dispatched the right tool");
  else fail("loop tool", JSON.stringify(calls));
  if (result.tool_calls === 1) ok("loop: tool_calls=1 in result");
  else fail("loop count", String(result.tool_calls));
  if (!result.budget_exceeded) ok("loop: budget not exceeded");
  else fail("budget", "exceeded");
  if (result.content.includes("capabilities")) ok("loop: returns final content");
  else fail("loop content", result.content);
}

// Budget exceeded — model keeps calling tools past the cap.
{
  const provider = new FakeProvider(Array.from({ length: 10 }, () => ({
    content: "",
    tool_calls: [{ id: "x", name: "list_directory", arguments: JSON.stringify({ path: "." }) }],
    usage: {},
  })));
  const reg = buildToolRegistry(tmpRoot);
  const result = await runToolLoop({
    provider,
    model: "fake-model",
    systemPrompt: "sys",
    userPrompt: "go",
    tools: reg,
    maxToolCalls: 3,
  });
  if (result.budget_exceeded) ok("loop: hit budget cap (3) → budget_exceeded");
  else fail("budget enforce", "did not flip");
}

// Unknown tool → error result fed back, model can recover.
{
  const provider = new FakeProvider([
    {
      content: "",
      tool_calls: [{ id: "1", name: "made_up_tool", arguments: "{}" }],
      usage: {},
    },
    { content: '{"capabilities":[]}', usage: {} },
  ]);
  const reg = buildToolRegistry(tmpRoot);
  let toolResultSeen: unknown = null;
  await runToolLoop({
    provider,
    model: "fake",
    systemPrompt: "s",
    userPrompt: "u",
    tools: reg,
    maxToolCalls: 5,
    onToolCall: (c) => { toolResultSeen = c.result; },
  });
  if (toolResultSeen && typeof toolResultSeen === "object" && "error" in (toolResultSeen as object)) {
    ok("loop: unknown tool returns error JSON (model can recover)");
  } else {
    fail("unknown tool", JSON.stringify(toolResultSeen));
  }
}

// ─── Section 5: parseLLMOutput ────────────────────────────────────────────

console.log("\nSection 5: parseLLMOutput");

{
  // Plain JSON object.
  const parsed = parseLLMOutput(JSON.stringify({
    capabilities: [
      { name: "rename_user", entity: "User", params: [{ name: "u", type: "User" }, { name: "name", type: "string" }], effects: [{ target: "User.name", op: "assign", value: "name" }], requires: ["name != \"\""], source_file: "src/user.ts", source_line: 7, confidence: "high" },
    ],
  }));
  if (parsed.length === 1 && parsed[0].name === "rename_user") ok("parse: plain JSON object");
  else fail("parse plain", JSON.stringify(parsed));

  // ```json fence.
  const fenced = parseLLMOutput(
    'Here is the result:\n```json\n{"capabilities":[{"name":"x","entity":"E","source_file":"f.ts","source_line":1,"confidence":"low"}]}\n```\nLet me know if you need more.',
  );
  if (fenced.length === 1 && fenced[0].name === "x") ok("parse: extracts from fenced block");
  else fail("parse fence", JSON.stringify(fenced));

  // No JSON at all → empty list.
  const none = parseLLMOutput("I'm not sure what to say.");
  if (none.length === 0) ok("parse: empty when no JSON");
  else fail("parse empty", JSON.stringify(none));

  // Invalid JSON → empty list (no throw).
  const broken = parseLLMOutput("{ this is broken json }");
  if (broken.length === 0) ok("parse: empty when JSON is broken");
  else fail("parse broken", JSON.stringify(broken));

  // Malformed records (missing required fields) get dropped silently.
  const mixed = parseLLMOutput(JSON.stringify({
    capabilities: [
      { /* missing everything */ },
      { name: "a", entity: "E", source_file: "f.ts", confidence: "high" },
      { name: "b", entity: "E", source_file: "g.ts", confidence: "wat" }, // bad confidence
      { name: "c", entity: "E", source_file: "h.ts", confidence: "medium" }, // good
    ],
  }));
  if (mixed.length === 2 && mixed.every(c => ["a", "c"].includes(c.name))) {
    ok("parse: drops malformed records");
  } else {
    fail("parse mixed", JSON.stringify(mixed));
  }
}

// ─── Section 6: filterInferredCapabilities ───────────────────────────────

console.log("\nSection 6: filterInferredCapabilities");

{
  const staticResult: ReflectionResult = {
    entities: [
      { name: "User", source_file: "src/user.ts", fields: [] },
      { name: "Post", source_file: "src/post.ts", fields: [] },
    ],
    unparsed: [],
  };
  const llm: ReflectionLLMResult = {
    capabilities: [
      { name: "rename_user", entity: "User", params: [], effects: [], requires: [], source_file: "src/user.ts", source_line: 1, confidence: "high" },
      { name: "ghost_op", entity: "Ghost", params: [], effects: [], requires: [], source_file: "src/ghost.ts", source_line: 1, confidence: "low" },
      { name: "rename_user", entity: "User", params: [], effects: [], requires: [], source_file: "src/dup.ts", source_line: 1, confidence: "low" }, // duplicate
      { name: "1bad-name", entity: "User", params: [], effects: [], requires: [], source_file: "src/x.ts", source_line: 1, confidence: "low" }, // invalid identifier
    ],
    trace: { tool_calls: 5, total_prompt_tokens: 100, total_completion_tokens: 50, budget_exceeded: false },
  };
  const { kept, dropped } = filterInferredCapabilities(staticResult, llm);
  if (kept.capabilities.length === 1 && kept.capabilities[0].name === "rename_user") ok("filter: keeps known + first-seen");
  else fail("filter kept", JSON.stringify(kept.capabilities.map(c => c.name)));
  if (dropped.length === 3) ok("filter: drops unknown + duplicate + invalid");
  else fail("filter dropped", JSON.stringify(dropped));
  // Trace stats survive the filter.
  if (kept.trace.tool_calls === 5) ok("filter: preserves trace stats");
  else fail("filter trace", String(kept.trace.tool_calls));
}

// ─── Section 7: emitEnrichedStub ─────────────────────────────────────────

console.log("\nSection 7: emitEnrichedStub");

{
  const staticResult: ReflectionResult = {
    entities: [
      { name: "User", source_file: "src/user.ts", fields: [
        { name: "id", type: "uuid", optional: false },
        { name: "email", type: "string", optional: false },
        { name: "name", type: "string", optional: false },
      ] },
    ],
    unparsed: [],
  };
  const llm: ReflectionLLMResult = {
    capabilities: [
      {
        name: "rename_user",
        entity: "User",
        params: [{ name: "u", type: "User" }, { name: "name", type: "string" }],
        effects: [{ target: "u.name", op: "assign", value: "name" }],
        requires: ["name != \"\""],
        source_file: "src/user.ts",
        source_line: 7,
        confidence: "high",
      },
    ],
    trace: { tool_calls: 8, total_prompt_tokens: 200, total_completion_tokens: 100, budget_exceeded: false },
  };
  const stub = emitEnrichedStub("MyApp", staticResult, llm);

  if (stub.includes("entity User {")) ok("stub: emits User entity");
  else fail("stub entity", "missing");
  if (stub.includes("capability rename_user(u: User, name: string)")) ok("stub: emits capability with typed params");
  else fail("stub capability", "missing");
  if (stub.includes("u.name = name")) ok("stub: emits assign effect");
  else fail("stub effect", "missing");
  if (stub.includes("name != \"\"")) ok("stub: emits requires clause");
  else fail("stub requires", "missing");
  if (stub.includes("// inferred (confidence: high)")) ok("stub: confidence comment");
  else fail("stub confidence comment", "missing");
  if (stub.includes("Tool calls: 8")) ok("stub: header includes tool-call stats");
  else fail("stub header", "missing");
  // No ontology fields.
  if (!stub.match(/owns:\s*\[\s*id:\s*uuid/)) ok("stub: omits ontology id field");
  else fail("ontology id", "leaked");
}

// ─── Section 8: end-to-end with FakeProvider ────────────────────────────

console.log("\nSection 8: reflectProjectWithLLM end-to-end");

{
  // Three-turn script: (1) tool_call for cap pass, (2) final cap JSON,
  // (3) final SM JSON (the SM pass runs separately after capabilities).
  const provider = new FakeProvider([
    {
      content: "",
      tool_calls: [{ id: "1", name: "list_directory", arguments: JSON.stringify({ path: "src" }) }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    },
    {
      content: JSON.stringify({
        capabilities: [
          { name: "rename_user", entity: "User", params: [{ name: "u", type: "User" }, { name: "name", type: "string" }], effects: [{ target: "u.name", op: "assign", value: "name" }], requires: ["name != \"\""], source_file: "src/user.ts", source_line: 7, confidence: "high" },
        ],
      }),
      usage: { prompt_tokens: 120, completion_tokens: 60 },
    },
    // SM pass — returns one state machine.
    {
      content: JSON.stringify({
        state_machines: [
          { entity: "User", field: "status", states: ["active", "suspended", "deleted"], transitions: [{ from: "active", to: "suspended", trigger: null }, { from: "suspended", to: "deleted", trigger: null }], source_file: "src/user.ts", confidence: "medium" },
        ],
      }),
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    },
  ]);
  const result = await reflectProjectWithLLM({
    root: tmpRoot,
    provider,
    model: "fake-model",
    maxToolCalls: 10,
  });
  if (result.static_result.entities.length === 2) ok("e2e: static analysis found 2 entities");
  else fail("static count", String(result.static_result.entities.length));
  if (result.llm_result.capabilities.length === 1 && result.llm_result.capabilities[0].name === "rename_user") {
    ok("e2e: LLM inferred 1 capability");
  } else {
    fail("llm count", JSON.stringify(result.llm_result.capabilities.map(c => c.name)));
  }
  if (result.llm_result.trace.tool_calls === 1) ok("e2e: trace records 1 tool call");
  else fail("trace calls", String(result.llm_result.trace.tool_calls));
  if (result.llm_result.trace.total_prompt_tokens === 170) ok("e2e: trace records 170 prompt tokens (50+120)");
  else fail("trace prompt tokens", String(result.llm_result.trace.total_prompt_tokens));
  if (!result.llm_result.trace.budget_exceeded) ok("e2e: budget not exceeded");
  else fail("trace budget", "exceeded");
  // v2.5: state machine results.
  if (result.sm_result.state_machines.length === 1 && result.sm_result.state_machines[0].entity === "User") {
    ok("e2e: SM pass inferred 1 state machine for User");
  } else {
    fail("sm count", JSON.stringify(result.sm_result.state_machines.map(s => s.entity)));
  }
  if (result.sm_result.state_machines[0].states.length === 3) ok("e2e: SM has 3 states");
  else fail("sm states", JSON.stringify(result.sm_result.state_machines[0]?.states));
}

// ─── Section 9: empty project ─────────────────────────────────────────────

console.log("\nSection 9: empty project (no entities)");

{
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marrow-phase20v2-empty-"));
  // FakeProvider should never be called when there are no entities.
  const provider = new FakeProvider([]);
  const result = await reflectProjectWithLLM({ root: emptyRoot, provider });
  if (result.llm_result.capabilities.length === 0) ok("empty project: no capabilities");
  else fail("empty caps", JSON.stringify(result.llm_result.capabilities));
  if (provider.called === 0) ok("empty project: provider never called (short-circuit)");
  else fail("short-circuit", String(provider.called));
  fs.rmSync(emptyRoot, { recursive: true, force: true });
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
try { fs.rmSync(path.join(tmpRoot, "..", "marrow-phase20v2-outside"), { recursive: true, force: true }); } catch { /* */ }

console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 20 v2 results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);

}

main().catch(err => {
  console.error("test runner failed:", err && err.message ? err.message : err);
  process.exit(1);
});
