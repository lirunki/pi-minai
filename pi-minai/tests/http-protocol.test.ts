import assert from "node:assert/strict";
import test from "node:test";
import { HttpProtocolError, PiHttpTextAdapter, mapThinking } from "../src/index.js";
import type { NormalizedChatRequest, PiSessionLike } from "../src/index.js";

class FakeHttpSession implements PiSessionLike {
  listener?: (event: { type: string; [key: string]: unknown }) => void;
  disposed = false;
  aborted = false;
  promptText = "";
  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async prompt(text: string): Promise<void> {
    this.promptText = text;
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
    this.listener?.({ type: "message_end", usage: { input: 12, output: 2, total: 14 } });
  }
  async abort(): Promise<void> { this.aborted = true; }
  dispose(): void { this.disposed = true; }
}

const request: NormalizedChatRequest = {
  protocol: "openai",
  requestId: "r1",
  model: { provider: "openai", id: "model" },
  messages: [{ role: "user", content: "Say hello" }],
  stream: false,
};

test("maps effort and thinking controls without inventing levels", () => {
  assert.equal(mapThinking({ effort: "none" }), "off");
  assert.equal(mapThinking({ effort: "high" }), "high");
  assert.equal(mapThinking({ think: true }), undefined);
  assert.equal(mapThinking({ think: "medium" }), "medium");
});

test("non-stream adapter renders messages and maps Pi text and usage", async () => {
  let session!: FakeHttpSession;
  const adapter = new PiHttpTextAdapter(async ({ thinking }) => { assert.equal(thinking, "high"); session = new FakeHttpSession(); return session; });
  const result = await adapter.complete({ ...request, thinking: { effort: "high" } });
  assert.equal(result.text, "hello world");
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 2, totalTokens: 14 });
  assert.equal(result.effectiveThinking, "high");
  assert.match(session.promptText, /\[user\]\nSay hello/);
  assert.equal(session.disposed, true);
});

test("first slice rejects streaming and caller-provided tools", async () => {
  const adapter = new PiHttpTextAdapter(async () => new FakeHttpSession());
  await assert.rejects(() => adapter.complete({ ...request, stream: true }), (error: unknown) => error instanceof HttpProtocolError && error.code === "http_unsupported");
  await assert.rejects(() => adapter.complete({ ...request, tools: [{ name: "external", parameters: {} }] }), /continuation adapter/);
});

test("maxOutputTokens is forwarded to the session factory", async () => {
  let captured: number | undefined;
  const adapter = new PiHttpTextAdapter(async ({ maxOutputTokens }) => { captured = maxOutputTokens; return new FakeHttpSession(); });
  await adapter.complete({ ...request, maxOutputTokens: 10 });
  assert.equal(captured, 10);
  captured = undefined;
  await adapter.complete(request);
  assert.equal(captured, undefined);
});

test("aborted request does not create a session", async () => {
  const controller = new AbortController();
  controller.abort();
  let created = false;
  const adapter = new PiHttpTextAdapter(async () => { created = true; return new FakeHttpSession(); });
  await assert.rejects(() => adapter.complete(request, controller.signal), /aborted/);
  assert.equal(created, false);
});
