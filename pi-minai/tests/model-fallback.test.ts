import assert from "node:assert/strict";
import test from "node:test";
import { ModelExecutionRouter } from "../src/index.js";
import type { ModelHostService, RegistryModelRouter } from "../src/index.js";

const request = { protocol: "openai" as const, requestId: "r", model: { provider: "default", id: "auto" }, messages: [{ role: "user" as const, content: "hi" }], stream: false };
const a = { provider: "p", id: "a" };
const b = { provider: "p", id: "b" };

function okHost(text: string, calls: string[]): ModelHostService {
  return { ready: async () => true, invoke: async (input) => { calls.push(`${input.model.provider}/${input.model.id}`); return { model: input.model, text, finishReason: "stop" }; }, async *stream() { yield { type: "delta", text }; yield { type: "done", result: { model: a, text: "", finishReason: "stop" } }; } };
}
function failingHost(error: Error): ModelHostService {
  return { ready: async () => true, invoke: async () => { throw error; }, async *stream() { throw error; yield undefined as never; } };
}
function routerWithHosts(hosts: Record<string, ModelHostService>, selectOrder: unknown[] = [a, b]): RegistryModelRouter {
  return { select: async () => ({ model: a, source: "fallback", candidates: [a, b], order: selectOrder }), host: (reference: { provider: string; id: string }) => hosts[`${reference.provider}/${reference.id}`]! } as unknown as RegistryModelRouter;
}

test("auto selection falls back to the next model when the first is unreachable and warns", async () => {
  const calls: string[] = [];
  const events: Array<{ phase: string; message: string; model?: string }> = [];
  const hosts = { "p/a": failingHost(new Error("connection refused")), "p/b": okHost("second answer", calls) };
  const result = await new ModelExecutionRouter(routerWithHosts(hosts), { onProgress: (event) => events.push({ phase: event.phase, message: event.message, ...(event.model ? { model: event.model } : {}) }) }).complete(request);
  assert.equal(result.text, "second answer");
  assert.deepEqual(result.model, b);
  assert.deepEqual(calls, ["p/b"]); // failingHost throws before recording its call
  const warnings = events.filter((event) => event.phase === "model_fallback");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message, /p\/a unreachable \(connection refused\) — falling back to p\/b/);
  assert.equal(warnings[0]!.model, "p/b");
});

test("fallback order honors the selector's ranking, not the catalog order", async () => {
  const calls: string[] = [];
  const hosts = { "p/a": okHost("a answer", calls), "p/b": okHost("b answer", calls) };
  const result = await new ModelExecutionRouter(routerWithHosts(hosts, [b, a])).complete(request);
  assert.equal(result.text, "b answer");
  assert.deepEqual(calls, ["p/b"]);
});

test("when every candidate fails, the last warning reports no fallback left and the error surfaces", async () => {
  const events: Array<{ phase: string; message: string }> = [];
  const hosts = { "p/a": failingHost(new Error("down A")), "p/b": failingHost(new Error("down B")) };
  await assert.rejects(
    new ModelExecutionRouter(routerWithHosts(hosts), { onProgress: (event) => events.push({ phase: event.phase, message: event.message }) }).complete(request),
    /down B/,
  );
  const warnings = events.filter((event) => event.phase === "model_fallback");
  assert.equal(warnings.length, 2);
  assert.match(warnings[1]!.message, /p\/b unreachable \(down B\) — no fallback models left/);
});

test("explicit model requests never fall back", async () => {
  const calls: string[] = [];
  const hosts = { "p/a": failingHost(new Error("down")) };
  const events: Array<{ phase: string; message: string }> = [];
  await assert.rejects(
    new ModelExecutionRouter({ host: () => hosts["p/a"] } as unknown as RegistryModelRouter, { onProgress: (event) => events.push({ phase: event.phase, message: event.message }) }).complete({ ...request, model: { provider: "p", id: "a" } }),
    /down/,
  );
  assert.equal(events.filter((event) => event.phase === "model_fallback").length, 0);
  assert.deepEqual(calls, []);
});

test("streaming falls back before any content was produced", async () => {
  const hosts = { "p/a": failingHost(new Error("connect ECONNREFUSED")), "p/b": okHost("streamed", []) };
  const events: Array<{ type: string; delta?: string; model?: unknown }> = [];
  for await (const event of new ModelExecutionRouter(routerWithHosts(hosts)).stream({ ...request, stream: true })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text_delta", "done"]);
  assert.equal((events[0] as { delta: string }).delta, "streamed");
  assert.deepEqual((events[1] as { result: { model: unknown } }).result.model, b);
});

test("streaming does not fall back after content was already produced (no duplicate output)", async () => {
  let first = true;
  const midStreamFail: ModelHostService = { ready: async () => true, invoke: async () => { throw new Error("unused"); }, async *stream() { yield { type: "delta", text: "partial " }; throw new Error("stream died mid-flight"); } };
  const good = okHost("should-not-duplicate", []);
  const hosts: Record<string, ModelHostService> = { "p/a": midStreamFail, "p/b": good };
  const modelRouter = { select: async () => ({ model: a, source: "fallback", candidates: [a, b], order: [a, b] }), host: (reference: { provider: string; id: string }) => { void first; return hosts[`${reference.provider}/${reference.id}`]!; } } as unknown as RegistryModelRouter;
  await assert.rejects(
    (async () => { for await (const _event of new ModelExecutionRouter(modelRouter).stream({ ...request, stream: true })) { /* consume */ } })(),
    /stream died mid-flight/,
  );
  void first;
});

test("cancelled requests abort immediately without fallback", async () => {
  const controller = new AbortController();
  controller.abort(new Error("HTTP run cancelled"));
  const events: Array<{ phase: string }> = [];
  const calls: string[] = [];
  const hosts = { "p/a": failingHost(new Error("cancelled")), "p/b": okHost("x", calls) };
  await assert.rejects(
    new ModelExecutionRouter(routerWithHosts(hosts), { onProgress: (event) => events.push({ phase: event.phase, message: event.message }) }).complete(request, controller.signal),
  );
  assert.equal(events.filter((event) => event.phase === "model_fallback").length, 0);
  assert.deepEqual(calls, []);
});

test("selections without a declared order fall back through the candidate list (compat)", async () => {
  const calls: string[] = [];
  const hosts = { "p/a": failingHost(new Error("down A")), "p/b": okHost("compat answer", calls) };
  const modelRouter = { select: async () => ({ model: a, source: "embedding", candidates: [a, b] }), host: (reference: { provider: string; id: string }) => hosts[`${reference.provider}/${reference.id}`]! } as unknown as RegistryModelRouter;
  const result = await new ModelExecutionRouter(modelRouter).complete(request);
  assert.equal(result.text, "compat answer");
  assert.deepEqual(calls, ["p/b"]); // failingHost throws before recording its call
});
