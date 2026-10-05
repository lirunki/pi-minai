import assert from "node:assert/strict";
import test from "node:test";
import { HttpProtocolError, PiHttpStreamAdapter } from "../src/index.js";
import type { NormalizedChatRequest, PiSessionLike } from "../src/index.js";

class StreamingSession implements PiSessionLike {
  listener?: (event: { type: string; [key: string]: unknown }) => void;
  disposed = false;
  aborted = false;
  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async prompt(): Promise<void> {
    this.listener?.({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
    this.listener?.({ type: "tool_execution_end", toolName: "read", isError: false });
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think" } });
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
    this.listener?.({ type: "message_end", usage: { input: 4, output: 2, total: 6 } });
  }
  async abort(): Promise<void> { this.aborted = true; }
  dispose(): void { this.disposed = true; }
}

const request: NormalizedChatRequest = {
  protocol: "openai", requestId: "stream-1", model: { provider: "p", id: "m" },
  messages: [{ role: "user", content: "hello" }], stream: true,
};

test("stream adapter yields thinking, text, and terminal usage", async () => {
  let session!: StreamingSession;
  const adapter = new PiHttpStreamAdapter(async () => { session = new StreamingSession(); return session; });
  const events = [];
  for await (const event of adapter.stream(request, undefined)) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["thinking_delta", "thinking_delta", "thinking_delta", "text_delta", "done"]);
  assert.equal(events[0]?.type === "thinking_delta" ? events[0].delta : "", `[action:start] read {"path":"src/index.ts"}\n`);
  assert.equal(events[1]?.type === "thinking_delta" ? events[1].delta : "", `[action:end] read\n`);
  const done = events[4];
  assert.equal(done.type, "done");
  if (done.type === "done") assert.deepEqual(done.result.usage, { promptTokens: 4, completionTokens: 2, totalTokens: 6 });
  assert.equal(session.disposed, true);
});

test("consumer cancellation aborts and disposes the session", async () => {
  let session!: StreamingSession;
  const adapter = new PiHttpStreamAdapter(async () => { session = new StreamingSession(); return session; });
  const stream = adapter.stream(request);
  await stream.next();
  await stream.return?.(undefined);
  assert.equal(session.aborted, true);
  assert.equal(session.disposed, true);
});

test("stream adapter validates stream mode and preserves unsupported controls", async () => {
  const adapter = new PiHttpStreamAdapter(async () => new StreamingSession());
  await assert.rejects(async () => { for await (const _event of adapter.stream({ ...request, stream: false })) {} }, (error: unknown) => error instanceof HttpProtocolError && error.code === "http_invalid_request");
  await assert.rejects(async () => { for await (const _event of adapter.stream({ ...request, tools: [{ name: "x", parameters: {} }] })) {} }, /continuation adapter/);
});
