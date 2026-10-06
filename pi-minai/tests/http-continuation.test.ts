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
    const toolResult = await Object.values(this.tools)[0]!({ toolCallId: "call-1", name: "external", arguments: { x: 1 } });
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
  // The session sees the namespaced tool (caller_external) so it can never shadow a built-in.
  assert.deepEqual(receivedTools, [{ name: "caller_external", parameters: {} }]);
  // ...but the wire pause event keeps the caller's original tool name.
  assert.equal(pause.value.calls[0]!.name, "external");
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

test("nudges the session once when the model ends its turn without a tool call or answer", async () => {
  const prompts: string[] = [];
  class ShySession implements PiSessionLike {
    private listener?: (event: { type: string; [key: string]: unknown }) => void;
    nudged = false;
    subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
    async prompt(message?: string): Promise<void> {
      prompts.push(message ?? "initial");
      if (message === undefined || !message.includes("ended without")) {
        // Degenerate turn: reasoning only, no tool call, no text.
        this.listener?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "I'll use the tool." } });
        return;
      }
      this.nudged = true;
      this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "called" } });
      await this.toolsExternal({ toolCallId: "call-1", name: "external", arguments: {} });
    }
    toolsExternal = async (call: { toolCallId: string; name: string; arguments: unknown }) => { await Object.values(this.externalMap)[0]!(call); };
    externalMap: Record<string, (call: { toolCallId: string; name: string; arguments: unknown }) => Promise<unknown>> = {};
    async abort(): Promise<void> {}
    dispose(): void {}
  }
  const session = new ShySession();
  const manager = new ExternalToolContinuationManager(async ({ externalTools }) => { session.externalMap = externalTools; return session; });
  const stream = manager.start(request);
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const event of stream) { events.push(event as { type: string } & Record<string, unknown>); if (event.type === "tool_pause_batch") break; }
  assert.equal(session.nudged, true, "the session should have been re-prompted with the nudge");
  assert.equal(prompts.length, 2, "exactly one nudge re-prompt");
  assert.match(prompts[1]!, /ended without calling a tool/);
  const pause = events.find((event) => event.type === "tool_pause_batch") as { calls: Array<{ continuationId: string }> } | undefined;
  assert.ok(pause, "a tool pause must be emitted after the nudge");
  const resumed = manager.resume(pause!.calls[0]!.continuationId, "result");
  const resumeEvents: string[] = [];
  for await (const event of resumed) resumeEvents.push(event.type);
  assert.deepEqual(resumeEvents, ["done"]);
});

test("gives up after one nudge and reports the empty result instead of looping", async () => {
  let prompts = 0;
  class SilentSession implements PiSessionLike {
    private listener?: (event: { type: string; [key: string]: unknown }) => void;
    subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
    async prompt(): Promise<void> { prompts++; this.listener?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "..." } }); }
    async abort(): Promise<void> {}
    dispose(): void {}
  }
  const manager = new ExternalToolContinuationManager(async () => new SilentSession());
  const events: Array<{ type: string; result?: { text: string } }> = [];
  for await (const event of manager.start(request)) events.push(event as { type: string; result?: { text: string } });
  assert.equal(prompts, 2, "initial prompt + exactly one nudge");
  const done = events.find((event) => event.type === "done");
  assert.ok(done, "stream still completes");
  assert.equal(done!.result!.text, "");
});

test("caller tool names are namespaced in the session and can never shadow built-ins", async () => {
  let receivedDefinitions: Array<{ name: string }> | undefined;
  let handlerKeys: string[] = [];
  let wiredName = "";
  const manager = new ExternalToolContinuationManager(async ({ tools, externalTools }) => {
    receivedDefinitions = tools.map((tool) => ({ name: tool.name }));
    handlerKeys = Object.keys(externalTools);
    return {
      subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void { listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }); return () => {}; },
      async prompt(): Promise<void> { wiredName = handlerKeys[0]!; },
      async abort(): Promise<void> {}, dispose(): void {},
    } as unknown as PiSessionLike;
  });
  // "read" is one of Pi's built-in tool names — the caller must not be able to shadow it.
  const request2 = { ...request, tools: [{ name: "read", parameters: {} }, { name: "get_location", parameters: {} }] };
  const stream = manager.start(request2);
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  try { for await (const event of stream) events.push(event as { type: string } & Record<string, unknown>); } catch { /* session never calls tools here */ }
  assert.deepEqual(receivedDefinitions!.map((tool) => tool.name), ["caller_read", "caller_get_location"]);
  assert.deepEqual(handlerKeys, ["caller_read", "caller_get_location"]);
  assert.equal(wiredName, "caller_read");
  // the pending/wire name stays the caller's original (no pause fired here since the fake session never calls)
  assert.ok(events.every((event) => event.type !== "tool_pause_batch"));
});

test("duplicate caller tool names are rejected", async () => {
  const manager = new ExternalToolContinuationManager(async ({ tools }) => ({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose() {} }) as unknown as PiSessionLike);
  const request2 = { ...request, tools: [{ name: "dup", parameters: {} }, { name: "dup", parameters: {} }] };
  await assert.rejects(async () => { for await (const _event of manager.start(request2)) {} }, (error: unknown) => error instanceof ContinuationError && error.code === "continuation_invalid" && error.message.includes("Duplicate caller tool name"));
});
