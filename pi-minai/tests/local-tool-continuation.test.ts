import assert from "node:assert/strict";
import test from "node:test";
import { LocalToolContinuationManager } from "../src/index.js";
import type { ModelHostService } from "../src/index.js";

function host(): ModelHostService { let turn = 0; return { ready: async () => true, invoke: async () => ({ model: { provider: "python-minai", id: "m" }, text: "" }), async *stream(invocation) { if (turn++ === 0) { yield { type: "tool_call", toolCall: { id: "call-1", name: "lookup", arguments: { q: "x" } } }; yield { type: "done", result: { model: invocation.model, text: "", finishReason: "tool_call", toolCalls: [{ id: "call-1", name: "lookup", arguments: { q: "x" } }] } }; } else { assert.equal(invocation.messages.at(-1)?.role, "tool"); yield { type: "delta", text: "result" }; yield { type: "done", result: { model: invocation.model, text: "result", finishReason: "stop" } }; } } }; }

test("local host continuation pauses and replays tool results", async () => {
  const manager = new LocalToolContinuationManager(() => host());
  const request = { protocol: "openai" as const, requestId: "r", model: { provider: "python-minai", id: "m" }, messages: [{ role: "user" as const, content: "hi" }], tools: [{ name: "lookup", parameters: {} }], stream: true };
  const first = []; for await (const event of manager.start(request)) first.push(event);
  assert.equal(first[0]!.type, "tool_pause_batch");
  const pause = first[0] as { calls: Array<{ continuationId: string }> };
  const second = []; for await (const event of manager.resumeBatch({ [pause.calls[0]!.continuationId]: "found" })) second.push(event);
  assert.equal(second.some((event) => event.type === "text_delta"), true);
});

test("local host continuation routes alias models before resolving a host", async () => {
  const seen: Array<{ provider: string; id: string }> = [];
  const plainHost: ModelHostService = { ready: async () => true, invoke: async () => ({ model: { provider: "llama-serve", id: "qwen2.5-0.5b" }, text: "ok" }), async *stream(invocation) { seen.push(invocation.model); yield { type: "delta", text: "ok" }; yield { type: "done", result: { model: invocation.model, text: "ok", finishReason: "stop" } }; } };
  const manager = new LocalToolContinuationManager(() => plainHost, 60_000, async () => ({ provider: "llama-serve", id: "qwen2.5-0.5b" }));
  const request = { protocol: "openai" as const, requestId: "alias", model: { provider: "default", id: "minai" }, messages: [{ role: "user" as const, content: "hi" }], tools: [{ name: "lookup", parameters: {} }], stream: true };
  const events = []; for await (const event of manager.start(request)) events.push(event);
  assert.deepEqual(seen[0], { provider: "llama-serve", id: "qwen2.5-0.5b" });
  assert.equal(events.some((event) => event.type === "done" && event.result.model.id === "qwen2.5-0.5b"), true);
});
