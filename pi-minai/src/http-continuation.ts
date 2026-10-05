import { randomBytes } from "node:crypto";
import type { ModelReference } from "./contracts/common.js";
import { MinaiPiError } from "./errors.js";
import type { PiSessionLike } from "./pi-task.js";
import type { HttpMessage, HttpToolDefinition, NormalizedChatRequest, NormalizedChatStreamEvent, UsageSnapshot } from "./http-protocol.js";

export type ExternalToolCall = { toolCallId: string; name: string; arguments: unknown };
export type ExternalToolHandler = (call: ExternalToolCall) => Promise<unknown>;
export type ExternalToolMap = Record<string, ExternalToolHandler>;
export type ContinuationSessionFactory = (input: { model: ModelReference; thinking?: "off" | "low" | "medium" | "high"; tools: HttpToolDefinition[]; externalTools: ExternalToolMap; signal?: AbortSignal }) => Promise<PiSessionLike>;

export type ToolPauseEvent = { type: "tool_pause"; requestId: string; model: ModelReference; continuationId: string; toolCallId: string; name: string; arguments: unknown };
export type ToolPauseBatchEvent = { type: "tool_pause_batch"; requestId: string; model: ModelReference; calls: Array<{ continuationId: string; toolCallId: string; name: string; arguments: unknown }> };
export type ContinuationStreamEvent = NormalizedChatStreamEvent | ToolPauseEvent | ToolPauseBatchEvent;
type QueueItem = ContinuationStreamEvent | { type: "close" };
type Pending = { continuationId: string; runId: string; toolCallId: string; name: string; arguments: unknown; resolve: (value: unknown) => void; reject: (reason?: unknown) => void; consumed: boolean; announced: boolean; timer: ReturnType<typeof setTimeout> };
type Run = { runId: string; request: NormalizedChatRequest; session: PiSessionLike; queue: QueueItem[]; waiters: Array<(item: QueueItem) => void>; pending: Map<string, Pending>; text: string; usage?: UsageSnapshot; unsubscribe: () => void; aborted: boolean; completed: boolean; pauseScheduled: boolean };

export class ContinuationError extends MinaiPiError {
  constructor(message: string, code: "continuation_invalid" | "continuation_expired" | "continuation_consumed" | "continuation_run" | "continuation_batch_required") { super(message, code); this.name = "ContinuationError"; }
}

function id(): string { return randomBytes(24).toString("base64url"); }
function renderMessages(messages: HttpMessage[]): string { return messages.map((message) => `[${message.name ?? message.role}]\n${message.content}`).join("\n\n"); }
function usageFromEvent(event: { [key: string]: unknown }): UsageSnapshot | undefined {
  const value = event.usage;
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = typeof usage.input === "number" ? usage.input : typeof usage.promptTokens === "number" ? usage.promptTokens : undefined;
  const completionTokens = typeof usage.output === "number" ? usage.output : typeof usage.completionTokens === "number" ? usage.completionTokens : undefined;
  const totalTokens = typeof usage.total === "number" ? usage.total : promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return { ...(promptTokens === undefined ? {} : { promptTokens }), ...(completionTokens === undefined ? {} : { completionTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) };
}

export class ExternalToolContinuationManager {
  private readonly runs = new Map<string, Run>();
  private readonly continuations = new Map<string, Pending>();
  constructor(private readonly createSession: ContinuationSessionFactory, private readonly ttlMs = 60_000) {}

  async *start(request: NormalizedChatRequest, signal?: AbortSignal): AsyncGenerator<ContinuationStreamEvent> {
    if (!request.stream) throw new ContinuationError("Continuation adapter requires streaming", "continuation_invalid");
    if (!request.tools?.length) throw new ContinuationError("At least one external tool is required", "continuation_invalid");
    if (signal?.aborted) throw new ContinuationError("Request was aborted", "continuation_run");
    const runId = id();
    let run!: Run;
    const push = (item: QueueItem): void => { const waiter = run.waiters.shift(); if (waiter) waiter(item); else if (run.queue.length < 256) run.queue.push(item); };
    const scheduleBatch = (): void => {
      if (run.pauseScheduled) return;
      run.pauseScheduled = true;
      queueMicrotask(() => {
        run.pauseScheduled = false;
        const calls = [...run.pending.values()].filter((item) => !item.announced);
        calls.forEach((item) => { item.announced = true; });
        if (calls.length > 0) push({ type: "tool_pause_batch", requestId: request.requestId, model: request.model, calls: calls.map((item) => ({ continuationId: item.continuationId, toolCallId: item.toolCallId, name: item.name, arguments: item.arguments })) });
      });
    };
    const tools: ExternalToolMap = Object.fromEntries(request.tools.map((tool) => [tool.name, async (call: ExternalToolCall) => {
      const continuationId = id();
      let resolve!: (value: unknown) => void;
      let reject!: (reason?: unknown) => void;
      const result = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
      const pending: Pending = { continuationId, runId, toolCallId: call.toolCallId, name: call.name, arguments: call.arguments, resolve, reject, consumed: false, announced: false, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      pending.timer = setTimeout(() => {
        if (pending.consumed) return;
        pending.consumed = true;
        this.continuations.delete(continuationId);
        run.pending.delete(continuationId);
        pending.reject(new ContinuationError("Continuation expired", "continuation_expired"));
        run.aborted = true;
        void run.session.abort();
        this.cleanup(run);
      }, this.ttlMs);
      run.pending.set(continuationId, pending);
      this.continuations.set(continuationId, pending);
      scheduleBatch();
      return result;
    }]));
    const session = await this.createSession({ model: request.model, tools: request.tools, externalTools: tools, signal });
    run = { runId, request, session, queue: [], waiters: [], pending: new Map(), text: "", unsubscribe: () => {}, aborted: false, completed: false, pauseScheduled: false };
    this.runs.set(runId, run);
    run.unsubscribe = session.subscribe((event) => {
      run.usage = usageFromEvent(event) ?? run.usage;
      if (event.type !== "message_update") return;
      const nested = event.assistantMessageEvent;
      if (typeof nested !== "object" || nested === null) return;
      const value = nested as Record<string, unknown>;
      if (typeof value.delta !== "string") return;
      if (value.type === "text_delta") { run.text += value.delta; push({ type: "text_delta", requestId: request.requestId, model: request.model, delta: value.delta }); }
      if (value.type === "thinking_delta") push({ type: "thinking_delta", requestId: request.requestId, model: request.model, delta: value.delta });
    });
    const abort = () => { run.aborted = true; for (const pending of run.pending.values()) pending.reject(new ContinuationError("Run aborted", "continuation_run")); void session.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    void session.prompt(renderMessages(request.messages)).then(() => {
      run.completed = true;
      push({ type: "done", result: { requestId: request.requestId, model: request.model, text: run.text, finishReason: "stop", ...(run.usage === undefined ? {} : { usage: run.usage }) } });
      push({ type: "close" });
    }).catch((error: unknown) => { push({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) }); push({ type: "close" }); });
    try {
      yield* this.consume(run);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (run.completed || run.aborted) this.cleanup(run);
    }
  }

  async *resume(continuationId: string, result: unknown, signal?: AbortSignal): AsyncGenerator<ContinuationStreamEvent> {
    const pending = this.continuations.get(continuationId);
    if (!pending) throw new ContinuationError("Unknown or expired continuation", "continuation_invalid");
    const run = this.runs.get(pending.runId);
    if (!run) throw new ContinuationError("Continuation run is unavailable", "continuation_run");
    if (run.pending.size > 1) throw new ContinuationError("This run requires all tool results as one batch", "continuation_batch_required");
    yield* this.resumeBatch({ [continuationId]: result }, signal);
  }

  async *resumeBatch(results: Record<string, unknown>, _signal?: AbortSignal): AsyncGenerator<ContinuationStreamEvent> {
    const ids = Object.keys(results);
    if (ids.length === 0) throw new ContinuationError("Tool result batch is empty", "continuation_invalid");
    const first = this.continuations.get(ids[0]!);
    if (!first) throw new ContinuationError("Unknown or expired continuation", "continuation_invalid");
    const run = this.runs.get(first.runId);
    if (!run || run.aborted) throw new ContinuationError("Continuation run is unavailable", "continuation_run");
    if (ids.length !== run.pending.size || ids.some((continuationId) => !run.pending.has(continuationId))) throw new ContinuationError("Tool result batch does not match all pending calls", "continuation_batch_required");
    const pending = ids.map((continuationId) => run.pending.get(continuationId)!);
    for (const item of pending) {
      if (item.consumed) throw new ContinuationError("Continuation has already been consumed", "continuation_consumed");
      item.consumed = true;
      clearTimeout(item.timer);
      this.continuations.delete(item.continuationId);
      run.pending.delete(item.continuationId);
      item.resolve(results[item.continuationId]);
    }
    yield* this.consume(run);
    if (run.completed) this.cleanup(run);
  }

  cancel(runId: string): void { const run = this.runs.get(runId); if (!run) return; run.aborted = true; for (const pending of run.pending.values()) pending.reject(new ContinuationError("Run cancelled", "continuation_run")); void run.session.abort(); this.cleanup(run); }

  /** Map client tool_call_ids to pending continuation ids (standard OpenAI resume path). */
  matchPending(toolCallIds: string[]): Record<string, string> {
    const match: Record<string, string> = {};
    for (const toolCallId of toolCallIds) if (this.continuations.has(toolCallId)) match[toolCallId] = toolCallId;
    return match;
  }

  private async *consume(run: Run): AsyncGenerator<ContinuationStreamEvent> {
    while (true) {
      const item = run.queue.shift() ?? await new Promise<QueueItem>((resolve) => run.waiters.push(resolve));
      if (item.type === "close") return;
      yield item;
      if (item.type === "tool_pause" || item.type === "tool_pause_batch") return;
    }
  }

  private cleanup(run: Run): void {
    run.unsubscribe();
    run.session.dispose();
    this.runs.delete(run.runId);
    for (const [continuationId, pending] of run.pending) { clearTimeout(pending.timer); this.continuations.delete(continuationId); }
  }
}
