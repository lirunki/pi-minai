import { randomBytes } from "node:crypto";
import type { ModelReference } from "./contracts/common.js";
import type { HttpToolDefinition, NormalizedChatRequest, NormalizedChatStreamEvent } from "./http-protocol.js";
import type { ModelHostService, ModelInvocation, ModelMessage, ModelToolCall } from "./model.js";

export type LocalToolPause = { type: "tool_pause_batch"; requestId: string; model: ModelReference; calls: Array<{ continuationId: string; toolCallId: string; name: string; arguments: unknown }> };
export type LocalToolEvent = NormalizedChatStreamEvent | LocalToolPause;
type Pending = { id: string; toolCallId: string; resolve: (value: unknown) => void; consumed: boolean; timer: ReturnType<typeof setTimeout> };
type QueueItem = LocalToolEvent | { type: "close" };
type Run = { request: NormalizedChatRequest; host: ModelHostService; model: ModelReference; messages: ModelMessage[]; pending: Map<string, Pending>; queue: QueueItem[]; waiters: Array<(item: QueueItem) => void>; paused: boolean; done: boolean; aborted: boolean };
function id(): string { return randomBytes(24).toString("base64url"); }

/** TypeScript-owned tool continuation for direct local-host execution. */
export class LocalToolContinuationManager {
  private readonly runs = new Set<Run>();
  constructor(private readonly resolveHost: (reference: ModelReference) => ModelHostService, private readonly ttlMs = 60_000, private readonly resolveModel?: (request: NormalizedChatRequest) => Promise<ModelReference>) {}
  private push(run: Run, item: QueueItem): void { const waiter = run.waiters.shift(); if (waiter) waiter(item); else run.queue.push(item); }
  private next(run: Run): Promise<QueueItem> { const item = run.queue.shift(); return item ? Promise.resolve(item) : new Promise((resolve) => run.waiters.push(resolve)); }
  private invocation(run: Run, messages: ModelMessage[]): ModelInvocation { const request = run.request; return { model: run.model, messages, tools: request.tools, temperature: request.temperature, maxOutputTokens: request.maxOutputTokens, thinking: request.thinking?.effort === "none" ? "off" : request.thinking?.effort ?? (typeof request.thinking?.think === "string" ? request.thinking.think : request.thinking?.think === false ? "off" : undefined) }; }
  async *start(request: NormalizedChatRequest, signal?: AbortSignal): AsyncGenerator<LocalToolEvent> { if (!request.tools?.length) throw new Error("Caller tools are required");
    // Route aliases (e.g. minai/minai) and auto selection before touching a host;
    // resolving the raw request model would fail for façade models.
    const model = (await this.resolveModel?.(request)) ?? request.model;
    const run: Run = { request, host: this.resolveHost(model), model, messages: request.messages.map((m) => ({ role: m.role, content: m.content, ...(m.toolCallId === undefined ? {} : { toolCallId: m.toolCallId }) })), pending: new Map(), queue: [], waiters: [], paused: false, done: false, aborted: false }; this.runs.add(run); const abort = () => { run.aborted = true; void run.host; }; signal?.addEventListener("abort", abort, { once: true }); void this.pump(run, signal); try { while (true) { const item = await this.next(run); if (item.type === "close") return; yield item; if (item.type === "tool_pause_batch") return; } } finally { signal?.removeEventListener("abort", abort); if (!run.paused) this.runs.delete(run); } }
  private async pump(run: Run, signal?: AbortSignal): Promise<void> { try { while (!run.aborted) { let text = ""; const calls: ModelToolCall[] = []; for await (const event of run.host.stream(this.invocation(run, run.messages), signal)) { if (event.type === "delta") { text += event.text; this.push(run, { type: "text_delta", requestId: run.request.requestId, model: run.model, delta: event.text }); } else if (event.type === "thinking_delta") this.push(run, { type: "thinking_delta", requestId: run.request.requestId, model: run.model, delta: event.text }); else if (event.type === "tool_call") calls.push(event.toolCall); } if (calls.length === 0) { this.push(run, { type: "done", result: { requestId: run.request.requestId, model: run.model, text, finishReason: "stop" } }); this.push(run, { type: "close" }); run.done = true; return; } const announced = calls.map((call) => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>((res) => { resolve = res; }); const continuationId = id(); const pending = { id: continuationId, toolCallId: call.id, resolve, consumed: false, timer: undefined as unknown as ReturnType<typeof setTimeout> }; run.pending.set(continuationId, pending); pending.timer = setTimeout(() => { if (!pending.consumed) { pending.consumed = true; pending.resolve({ error: "tool continuation expired" }); } }, this.ttlMs); return { call, continuationId, promise }; }); run.paused = true; this.push(run, { type: "tool_pause_batch", requestId: run.request.requestId, model: run.model, calls: announced.map(({ call, continuationId }) => ({ continuationId, toolCallId: call.id, name: call.name, arguments: call.arguments })) }); const results = await Promise.all(announced.map(({ promise }) => promise)); run.messages.push({ role: "assistant", content: text, toolCalls: calls }); calls.forEach((call, index) => run.messages.push({ role: "tool", toolCallId: call.id, content: typeof results[index] === "string" ? results[index] as string : JSON.stringify(results[index]) })); run.paused = false; } } catch (error) { this.push(run, { type: "error", requestId: run.request.requestId, model: run.model, message: error instanceof Error ? error.message : String(error) }); this.push(run, { type: "close" }); run.done = true; } }
  matchPending(toolCallIds: string[]): Record<string, string> {
    const pendingIds = new Set<string>();
    for (const run of this.runs) for (const continuationId of run.pending.keys()) pendingIds.add(continuationId);
    const match: Record<string, string> = {};
    for (const toolCallId of toolCallIds) if (pendingIds.has(toolCallId)) match[toolCallId] = toolCallId;
    return match;
  }

  async *resumeBatch(results: Record<string, unknown>, _signal?: AbortSignal): AsyncGenerator<LocalToolEvent> { const run = [...this.runs].find((candidate) => Object.keys(results).some((key) => candidate.pending.has(key))); if (!run) throw new Error("Unknown local tool continuation"); for (const [continuationId, value] of Object.entries(results)) { const pending = run.pending.get(continuationId); if (!pending || pending.consumed) throw new Error("Invalid or duplicate local tool continuation"); pending.consumed = true; clearTimeout(pending.timer); run.pending.delete(continuationId); pending.resolve(value); } while (true) { const item = await this.next(run); if (item.type === "close") { this.runs.delete(run); return; } yield item; if (item.type === "tool_pause_batch") return; } }
}
