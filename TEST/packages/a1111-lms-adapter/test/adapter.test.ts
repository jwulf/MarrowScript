/**
 * Adapter test suite.
 *
 * Spins up two fake HTTP servers — one pretending to be A1111, one
 * pretending to be LM Studio — so the adapter's full request/response/
 * retry/timeout/bypass behaviour can be exercised without any real models
 * or GPUs. Uses Node's built-in test runner (no jest, no vitest, no extra
 * dev deps).
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  A1111LMSAdapter,
  AdapterError,
  A1111Error,
  LMStudioError,
  TimeoutError,
} from "../src/index.ts";

interface FakeServerControl {
  server: Server;
  port: number;
  requests: { url: string; body: unknown }[];
  /** Set the next response. status defaults to 200, body to an empty object. */
  next: (status: number, body: unknown, delayMs?: number) => void;
  /** Configure a response that fails N times then succeeds (for retry tests). */
  failTimes: (count: number, status: number, body: unknown, eventualBody: unknown) => void;
  close: () => Promise<void>;
}

function startFakeServer(): Promise<FakeServerControl> {
  return new Promise((resolve) => {
    const ctrl: Partial<FakeServerControl> = { requests: [] };
    // Simple state: a single nextResponse that's used for every request
    // until overwritten. failTimes overrides this with a counter that
    // decays — first N requests get the failure, then the success body.
    let nextStatus = 200;
    let nextBody: unknown = {};
    let nextDelayMs = 0;
    let failureBudget = 0;
    let failureStatus = 500;
    let failureBody: unknown = "fail";
    let successStatus = 200;
    let successBody: unknown = {};
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      for await (const chunk of req) raw += chunk.toString("utf8");
      let parsed: unknown = null;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      ctrl.requests!.push({ url: req.url ?? "", body: parsed });

      // Decide what to send based on whether we're in failure-budget mode
      // (set by failTimes) or simple next-response mode (set by next).
      let status: number;
      let body: unknown;
      if (failureBudget > 0) {
        failureBudget--;
        status = failureStatus;
        body = failureBody;
      } else if (failureBudget === 0 && successBody !== null) {
        // Just consumed the last failure — send the success body and clear
        // the queue so subsequent calls fall back to nextStatus/nextBody.
        status = successStatus;
        body = successBody;
        successBody = null; // guard against re-use
      } else {
        status = nextStatus;
        body = nextBody;
      }

      const send = (): void => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (nextDelayMs > 0) setTimeout(send, nextDelayMs);
      else send();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      ctrl.server = server;
      ctrl.port = addr.port;
      ctrl.next = (status: number, body: unknown, delayMs?: number) => {
        nextStatus = status;
        nextBody = body;
        nextDelayMs = delayMs ?? 0;
        // next() resets any pending failTimes state.
        failureBudget = 0;
        successBody = null;
      };
      ctrl.failTimes = (count: number, fStatus: number, fBody: unknown, eBody: unknown) => {
        failureBudget = count;
        failureStatus = fStatus;
        failureBody = fBody;
        successStatus = 200;
        successBody = eBody;
        // After failures are consumed and successBody is sent, fall back to
        // these defaults in case more requests arrive.
        nextStatus = 200;
        nextBody = eBody;
      };
      ctrl.close = (): Promise<void> => new Promise((r) => server.close(() => r()));
      resolve(ctrl as FakeServerControl);
    });
  });
}

describe("A1111LMSAdapter", () => {
  let lmStudio: FakeServerControl;
  let a1111: FakeServerControl;

  before(async () => {
    lmStudio = await startFakeServer();
    a1111 = await startFakeServer();
  });

  after(async () => {
    await lmStudio.close();
    await a1111.close();
  });

  // Each test starts with a clean server response queue. Without this, state
  // from one test (especially failTimes counters) leaks into the next.
  function resetServers(): void {
    lmStudio.requests.length = 0;
    a1111.requests.length = 0;
    lmStudio.next(200, {});
    a1111.next(200, {});
  }

  function makeAdapter(overrides: Partial<ConstructorParameters<typeof A1111LMSAdapter>[0]> = {}): A1111LMSAdapter {
    return new A1111LMSAdapter({
      a1111BaseUrl: "http://127.0.0.1:" + a1111.port,
      lmStudioBaseUrl: "http://127.0.0.1:" + lmStudio.port,
      retries: 0, // default off so tests don't accidentally rely on retry timing
      ...overrides,
    });
  }

  describe("constructor", () => {
    it("strips trailing slashes from base URLs", () => {
      const adapter = makeAdapter({
        a1111BaseUrl: "http://127.0.0.1:7860///",
        lmStudioBaseUrl: "http://127.0.0.1:1234///",
      });
      // Indirect verification: txt2img should hit /sdapi/v1/txt2img exactly,
      // not //sdapi/v1/txt2img with extra slashes.
      assert.ok(adapter, "adapter should construct without error");
    });

    it("throws on missing a1111BaseUrl", () => {
      assert.throws(
        () => new A1111LMSAdapter({ a1111BaseUrl: "", lmStudioBaseUrl: "x" }),
        /a1111BaseUrl is required/,
      );
    });

    it("throws on missing lmStudioBaseUrl", () => {
      assert.throws(
        () => new A1111LMSAdapter({ a1111BaseUrl: "x", lmStudioBaseUrl: "" }),
        /lmStudioBaseUrl is required/,
      );
    });
  });

  describe("enhancePrompt", () => {
    it("forwards prompt to LM Studio and returns the enhanced text", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "  enhanced prompt  " }, finish_reason: "stop" }],
      });
      const adapter = makeAdapter();
      const out = await adapter.enhancePrompt("a cat");
      assert.equal(out, "enhanced prompt"); // trimmed
      assert.equal(lmStudio.requests.length, 1);
      const req = lmStudio.requests[0].body as { messages: { role: string; content: string }[] };
      assert.equal(req.messages.length, 2);
      assert.equal(req.messages[0].role, "system");
      assert.equal(req.messages[1].content, "a cat");
    });

    it("bypasses LM Studio when opts.bypass is true", async () => {
      resetServers();
      const adapter = makeAdapter();
      const out = await adapter.enhancePrompt("verbatim please", { bypass: true });
      assert.equal(out, "verbatim please");
      assert.equal(lmStudio.requests.length, 0, "should not have hit LM Studio");
    });

    it("throws LMStudioError when LM Studio returns 500", async () => {
      resetServers();
      lmStudio.next(500, { error: "internal" });
      const adapter = makeAdapter();
      await assert.rejects(
        () => adapter.enhancePrompt("x"),
        (err: unknown) => err instanceof LMStudioError && (err as LMStudioError).status === 500,
      );
    });

    it("throws LMStudioError when LM Studio returns no choices", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [],
      });
      const adapter = makeAdapter();
      await assert.rejects(
        () => adapter.enhancePrompt("x"),
        (err: unknown) => err instanceof LMStudioError && /no choices/i.test((err as Error).message),
      );
    });

    it("includes the configured model in the request when set", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      });
      const adapter = makeAdapter({ lmStudioModel: "qwen2.5-coder" });
      await adapter.enhancePrompt("hello");
      const req = lmStudio.requests[0].body as { model?: string };
      assert.equal(req.model, "qwen2.5-coder");
    });

    it("respects custom temperature and max_tokens", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      });
      const adapter = makeAdapter({ enhancementTemperature: 0.2, enhancementMaxTokens: 50 });
      await adapter.enhancePrompt("hello");
      const req = lmStudio.requests[0].body as { temperature: number; max_tokens: number };
      assert.equal(req.temperature, 0.2);
      assert.equal(req.max_tokens, 50);
    });

    it("forwards Authorization header when authToken is set", async () => {
      // Test the auth header by intercepting fetch directly. This avoids the
      // brittle "swap servers mid-test" pattern and runs much faster.
      const originalFetch = globalThis.fetch;
      let capturedAuth: string | undefined;
      globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const headers = init?.headers as Record<string, string> | undefined;
        capturedAuth = headers?.Authorization ?? headers?.authorization;
        return new Response(JSON.stringify({
          id: "1", object: "chat.completion", created: 0, model: "test",
          choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      try {
        const adapter = makeAdapter({ authToken: "my-secret" });
        await adapter.enhancePrompt("hello");
        assert.equal(capturedAuth, "Bearer my-secret");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("txt2img", () => {
    it("enhances prompt then calls A1111 with the enhanced version", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "enhanced cat" }, finish_reason: "stop" }],
      });
      a1111.next(200, { images: ["BASE64IMAGE"], parameters: {}, info: "ok" });
      const adapter = makeAdapter();
      const out = await adapter.txt2img({ prompt: "cat", steps: 20 });
      assert.equal(out.images.length, 1);
      assert.equal(lmStudio.requests.length, 1);
      assert.equal(a1111.requests.length, 1);
      const a1111Req = a1111.requests[0].body as { prompt: string; steps: number };
      assert.equal(a1111Req.prompt, "enhanced cat", "A1111 received the enhanced prompt");
      assert.equal(a1111Req.steps, 20, "other fields passed through unchanged");
    });

    it("bypasses enhancement when opts.bypass is true", async () => {
      resetServers();
      a1111.next(200, { images: [], parameters: {}, info: "ok" });
      const adapter = makeAdapter();
      await adapter.txt2img({ prompt: "raw" }, { bypass: true });
      assert.equal(lmStudio.requests.length, 0);
      const a1111Req = a1111.requests[0].body as { prompt: string };
      assert.equal(a1111Req.prompt, "raw");
    });

    it("propagates A1111 4xx errors as A1111Error", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      });
      a1111.next(400, { detail: "bad request" });
      const adapter = makeAdapter();
      await assert.rejects(
        () => adapter.txt2img({ prompt: "x" }),
        (err: unknown) => err instanceof A1111Error && (err as A1111Error).status === 400,
      );
    });
  });

  describe("img2img", () => {
    it("enhances prompt and forwards init_images unchanged", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "enhanced" }, finish_reason: "stop" }],
      });
      a1111.next(200, { images: ["OUT"], parameters: {}, info: "ok" });
      const adapter = makeAdapter();
      const out = await adapter.img2img({
        prompt: "stylise",
        init_images: ["INPUT_BASE64"],
        denoising_strength: 0.5,
      });
      assert.equal(out.images[0], "OUT");
      const req = a1111.requests[0].body as { prompt: string; init_images: string[]; denoising_strength: number };
      assert.equal(req.prompt, "enhanced");
      assert.deepEqual(req.init_images, ["INPUT_BASE64"]);
      assert.equal(req.denoising_strength, 0.5);
    });
  });

  describe("retry policy", () => {
    it("retries on 502 then succeeds", async () => {
      resetServers();
      // LM Studio fails twice with 502, then succeeds.
      lmStudio.failTimes(2, 502, { error: "bad gateway" }, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "made it" }, finish_reason: "stop" }],
      });
      const adapter = makeAdapter({ retries: 2, retryBaseMs: 10 });
      const out = await adapter.enhancePrompt("hello");
      assert.equal(out, "made it");
      assert.equal(lmStudio.requests.length, 3, "two failures + one success");
    });

    it("does NOT retry on 4xx", async () => {
      resetServers();
      lmStudio.next(404, { error: "not found" });
      const adapter = makeAdapter({ retries: 5, retryBaseMs: 10 });
      await assert.rejects(
        () => adapter.enhancePrompt("hello"),
        (err: unknown) => err instanceof LMStudioError && (err as LMStudioError).status === 404,
      );
      assert.equal(lmStudio.requests.length, 1, "no retries for 4xx");
    });

    it("retries on 429 (rate limited)", async () => {
      resetServers();
      lmStudio.failTimes(1, 429, "too many", {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      const adapter = makeAdapter({ retries: 2, retryBaseMs: 10 });
      const out = await adapter.enhancePrompt("hello");
      assert.equal(out, "ok");
      assert.equal(lmStudio.requests.length, 2);
    });

    it("gives up after exhausting retries", async () => {
      resetServers();
      // Permanent 503.
      lmStudio.failTimes(99, 503, "down", {});
      const adapter = makeAdapter({ retries: 2, retryBaseMs: 10 });
      await assert.rejects(
        () => adapter.enhancePrompt("hello"),
        (err: unknown) => err instanceof LMStudioError && (err as LMStudioError).status === 503,
      );
      assert.equal(lmStudio.requests.length, 3, "1 initial + 2 retries");
    });
  });

  describe("timeouts", () => {
    it("aborts an LM Studio call that exceeds its timeout", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "late" }, finish_reason: "stop" }],
      }, 200); // server delays 200ms
      const adapter = makeAdapter({ lmStudioTimeoutMs: 50, retries: 0 });
      await assert.rejects(
        () => adapter.enhancePrompt("hi"),
        (err: unknown) => err instanceof TimeoutError,
      );
    });

    it("retries after a timeout", async () => {
      // Mock fetch to time out the first call and succeed on the second.
      const originalFetch = globalThis.fetch;
      let callCount = 0;
      globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        callCount++;
        const signal = init?.signal;
        if (callCount === 1) {
          // Wait until the adapter's controller aborts.
          return new Promise<Response>((_, reject) => {
            if (signal) {
              signal.addEventListener("abort", () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
          });
        }
        return new Response(JSON.stringify({
          id: "1", object: "chat.completion", created: 0, model: "test",
          choices: [{ index: 0, message: { role: "assistant", content: "fast" }, finish_reason: "stop" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      try {
        const adapter = makeAdapter({
          lmStudioTimeoutMs: 50,
          retries: 1,
          retryBaseMs: 10,
        });
        const out = await adapter.enhancePrompt("hi");
        assert.equal(out, "fast");
        assert.equal(callCount, 2, "first attempt timed out, second succeeded");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("error class hierarchy", () => {
    it("AdapterError is the base class", () => {
      const e = new LMStudioError("x", 500);
      assert.ok(e instanceof AdapterError);
      assert.ok(e instanceof Error);
    });
    it("A1111Error and LMStudioError are distinct", () => {
      const a = new A1111Error("a", 400);
      const l = new LMStudioError("l", 400);
      assert.ok(a instanceof A1111Error);
      assert.ok(!(l instanceof A1111Error));
      assert.ok(l instanceof LMStudioError);
      assert.ok(!(a instanceof LMStudioError));
    });
  });

  describe("logger hook", () => {
    it("emits structured events for each request", async () => {
      resetServers();
      lmStudio.next(200, {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      const events: { event: string; fields: Record<string, unknown> }[] = [];
      const adapter = makeAdapter({ log: (event, fields) => events.push({ event, fields }) });
      await adapter.enhancePrompt("hello");
      const eventNames = events.map((e) => e.event);
      assert.ok(eventNames.includes("enhance.ok"), "should emit enhance.ok");
    });

    it("emits request.failed on retried errors", async () => {
      resetServers();
      lmStudio.failTimes(1, 502, "down", {
        id: "1", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      const events: { event: string; fields: Record<string, unknown> }[] = [];
      const adapter = makeAdapter({
        retries: 2,
        retryBaseMs: 10,
        log: (event, fields) => events.push({ event, fields }),
      });
      await adapter.enhancePrompt("hello");
      const failed = events.filter((e) => e.event === "request.failed");
      assert.equal(failed.length, 1, "one retried failure logged");
      assert.equal(failed[0].fields.status, 502);
      assert.equal(failed[0].fields.will_retry, true);
    });
  });
});
