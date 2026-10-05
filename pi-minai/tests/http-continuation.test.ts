import assert from "node:assert/strict";
import test from "node:test";
import { ContinuationError, ExternalToolContinuationManager } from "../src/index.js";
import type { NormalizedChatRequest, PiSessionLike } from "../src/index.js";

class ToolSession implements PiSessionLike {
  private listener?: (event: { type: string; [key: string]: unknown }) => void;
  disposed = false;
  aborted = false;
  constructor(private readonly tools: Record<string, (call: { toolCallId: string; name: string; arguments: unknown }) => Promise<unknown>>) {}
  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async prompt(): Promise<void> {
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "before" } });
    const toolResult = await this.tools.external({ toolCallId: "call-1", name: "external", arguments: { x: 1 } });
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `:${String((toolResult as { value: string }).value)}` } });
    this.listener?.({ type: "message_end", usage: { input: 5, output: 3, total: 8 } });
  }
  async abort(): Promise<void> { this.aborted = true; }
  dispose(): void { this.disposed = true; }
}

const request: NormalizedChatRequest = {
  protocol: "openai", requestId: "r-tool", model: { provider: "p", id: "m" },
  messages: [{ role: "user", content: "use the tool" }],
  tools: [{ name: "external", parameters: {} }], stream: true,
};

test("pauses on an external fake tool and resumes the same Pi session", async () => {
  let session!: ToolSession;
  let receivedTools: NormalizedChatRequest["tools"];
  const manager = new ExternalToolContinuationManager(async ({ externalTools, tools }) => { receivedTools = tools; session = new ToolSession(externalTools); return session; });
  const first = manager.start(request);
  const paused = await first.next();
  assert.equal(paused.value?.type, "text_delta");
  const pause = await first.next();
  assert.equal(pause.value?.type, "tool_pause_batch");
  if (pause.value?.type !== "tool_pause_batch") return;
  assert.deepEqual(receivedTools, request.tools);
  assert.deepEqual(manager.matchPending([pause.value.calls[0]!.continuationId, "call-1"]), { [pause.value.calls[0]!.continuationId]: pause.value.calls[0]!.continuationId });
  const resumed = manager.resume(pause.value.calls[0]!.continuationId, { value: "done" });
  const events = [];
  for await (const event of resumed) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text_delta", "done"]);
  assert.equal(session.disposed, true);
});

test("rejects unknown continuation IDs", async () => {
  const manager = new ExternalToolContinuationManager(async ({ externalTools }) => new ToolSession(externalTools));
  await assert.rejects(async () => { for await (const _event of manager.resume("missing", {})) {} }, (error: unknown) => error instanceof ContinuationError && error.code === "continuation_invalid");
});

test("expires an unconsumed continuation and rejects resume", async () => {
  const manager = new ExternalToolContinuationManager(async ({ externalTools }) => new ToolSession(externalTools), 5);
  const first = manager.start(request);
  await first.next();
  const pause = await first.next();
  if (pause.value?.type !== "tool_pause_batch") throw new Error("expected pause");
  await new Promise((resolve) => setTimeout(resolve, 15));
  await assert.rejects(async () => { for await (const _event of manager.resume(pause.value.calls[0]!.continuationId, {})) {} }, (error: unknown) => error instanceof ContinuationError && (error.code === "continuation_invalid" || error.code === "continuation_expired"));
  await first.return?.(undefined);
});
