import assert from "node:assert/strict";
import test from "node:test";
import { ContinuationError, ExternalToolContinuationManager } from "../src/index.js";
import type { NormalizedChatRequest, PiSessionLike } from "../src/index.js";

class ParallelSession implements PiSessionLike {
  private listener?: (event: { type: string; [key: string]: unknown }) => void;
  disposed = false;
  constructor(private readonly tools: Record<string, (call: { toolCallId: string; name: string; arguments: unknown }) => Promise<unknown>>) {}
  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async prompt(): Promise<void> {
    const values = await Promise.all([
      this.tools.first({ toolCallId: "call-a", name: "first", arguments: { n: 1 } }),
      this.tools.second({ toolCallId: "call-b", name: "second", arguments: { n: 2 } }),
    ]);
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: values.map((value) => (value as { value: string }).value).join(",") } });
  }
  async abort(): Promise<void> {}
  dispose(): void { this.disposed = true; }
}

const request: NormalizedChatRequest = {
  protocol: "openai", requestId: "parallel", model: { provider: "p", id: "m" }, messages: [{ role: "user", content: "parallel" }],
  tools: [{ name: "first", parameters: {} }, { name: "second", parameters: {} }], stream: true,
};

test("collects sibling tool calls and resumes atomically", async () => {
  let session!: ParallelSession;
  const manager = new ExternalToolContinuationManager(async ({ externalTools }) => { session = new ParallelSession(externalTools); return session; });
  const first = manager.start(request);
  const pause = await first.next();
  assert.equal(pause.value?.type, "tool_pause_batch");
  if (pause.value?.type !== "tool_pause_batch") return;
  assert.deepEqual(pause.value.calls.map((call) => call.toolCallId).sort(), ["call-a", "call-b"]);
  const results = Object.fromEntries(pause.value.calls.map((call) => [call.continuationId, { value: call.toolCallId }]));
  const resumed = manager.resumeBatch(results);
  const events = [];
  for await (const event of resumed) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text_delta", "done"]);
  assert.equal(session.disposed, true);
});

test("rejects partial batches and leaves all calls pending", async () => {
  const manager = new ExternalToolContinuationManager(async ({ externalTools }) => new ParallelSession(externalTools), 10);
  const first = manager.start(request);
  const pause = await first.next();
  if (pause.value?.type !== "tool_pause_batch") throw new Error("expected batch");
  const one = pause.value.calls[0]!;
  await assert.rejects(async () => { for await (const _event of manager.resumeBatch({ [one.continuationId]: {} })) {} }, (error: unknown) => error instanceof ContinuationError && error.code === "continuation_batch_required");
  await first.return?.(undefined);
});
