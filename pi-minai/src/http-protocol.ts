import type { ModelReference } from "./contracts/common.js";
import { MinaiPiError } from "./errors.js";
import type { PiSessionLike } from "./pi-task.js";

export type HttpRole = "system" | "user" | "assistant" | "tool";
export type HttpMessage = { role: HttpRole; content: string; name?: string; toolCallId?: string };
export type HttpToolDefinition = { name: string; description?: string; parameters: Record<string, unknown> };
export type HttpThinking = { effort?: "none" | "low" | "medium" | "high"; think?: boolean | "low" | "medium" | "high" };

export type NormalizedChatRequest = {
  protocol: "openai" | "ollama";
  requestId: string;
  sessionId?: string;
  model: ModelReference;
  messages: HttpMessage[];
  tools?: HttpToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  thinking?: HttpThinking;
  stream: boolean;
};

export type UsageSnapshot = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  estimated?: boolean;
};

export type NormalizedChatResult = {
  requestId: string;
  model: ModelReference;
  text: string;
  finishReason: "stop" | "length" | "tool_calls" | "error";
  usage?: UsageSnapshot;
  effectiveThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

export type NormalizedChatStreamEvent =
  | { type: "text_delta"; requestId: string; model: ModelReference; delta: string }
  | { type: "thinking_delta"; requestId: string; model: ModelReference; delta: string }
  | { type: "done"; result: NormalizedChatResult }
  | { type: "error"; requestId: string; model?: ModelReference; message: string };

export class HttpProtocolError extends MinaiPiError {
  constructor(message: string, code: "http_invalid_request" | "http_unsupported" | "http_context" | "http_execution") {
    super(message, code);
    this.name = "HttpProtocolError";
  }
}

export function mapThinking(input?: HttpThinking): "off" | "low" | "medium" | "high" | undefined {
  if (input?.effort === "none" || input?.think === false) return "off";
  const value = typeof input?.think === "string" ? input.think : input?.effort;
  return value;
}

function renderMessages(messages: HttpMessage[]): string {
  return messages.map((message) => {
    const label = message.name ?? message.role;
    return `[${label}]\n${message.content}`;
  }).join("\n\n");
}

function usageFromEvent(event: { type: string; [key: string]: unknown }): UsageSnapshot | undefined {
  const candidate = event.usage;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const usage = candidate as Record<string, unknown>;
  const promptTokens = typeof usage.input === "number" ? usage.input : typeof usage.promptTokens === "number" ? usage.promptTokens : undefined;
  const completionTokens = typeof usage.output === "number" ? usage.output : typeof usage.completionTokens === "number" ? usage.completionTokens : undefined;
  const totalTokens = typeof usage.total === "number" ? usage.total : typeof usage.totalTokens === "number" ? usage.totalTokens : promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export type HttpPiSessionFactory = (input: { requestId?: string; model: ModelReference; thinking?: "off" | "low" | "medium" | "high"; maxOutputTokens?: number; signal?: AbortSignal }) => Promise<PiSessionLike>;

export class PiHttpStreamAdapter {
  constructor(private readonly createSession: HttpPiSessionFactory) {}

  async *stream(request: NormalizedChatRequest, signal?: AbortSignal): AsyncGenerator<NormalizedChatStreamEvent> {
    if (!request.stream) throw new HttpProtocolError("Streaming request flag is required", "http_invalid_request");
    if (request.messages.length === 0) throw new HttpProtocolError("At least one message is required", "http_invalid_request");
    if (request.tools && request.tools.length > 0) throw new HttpProtocolError("Caller-provided tools require the continuation adapter", "http_unsupported");
    if (signal?.aborted) throw new HttpProtocolError("Request was aborted", "http_execution");

    const thinking = mapThinking(request.thinking);
    let session: PiSessionLike;
    try {
      session = await this.createSession({ requestId: request.requestId, model: request.model, thinking, ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }), signal });
    } catch (error) {
      throw new HttpProtocolError(`Could not create Pi session: ${error instanceof Error ? error.message : String(error)}`, "http_execution");
    }

    type QueueItem = NormalizedChatStreamEvent | { type: "close" };
    const queue: QueueItem[] = [];
    const waiters: Array<(item: QueueItem) => void> = [];
    let closed = false;
    const push = (item: QueueItem): void => {
      const waiter = waiters.shift();
      if (waiter) waiter(item); else if (queue.length < 256) queue.push(item);
    };
    const next = (): Promise<QueueItem> => {
      const item = queue.shift();
      if (item) return Promise.resolve(item);
      return new Promise((resolve) => waiters.push(resolve));
    };
    let text = "";
    let usage: UsageSnapshot | undefined;
    const unsubscribe = session.subscribe((event) => {
      usage = usageFromEvent(event) ?? usage;
      if (event.type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        let args = "";
        try { args = event.args === undefined ? "" : ` ${JSON.stringify(event.args)}`; } catch { args = " [unserializable args]"; }
        push({ type: "thinking_delta", requestId: request.requestId, model: request.model, delta: `[action:start] ${toolName}${args}\n` });
        return;
      }
      if (event.type === "tool_execution_end") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        const suffix = event.isError === true ? " (error)" : "";
        push({ type: "thinking_delta", requestId: request.requestId, model: request.model, delta: `[action:end] ${toolName}${suffix}\n` });
        return;
      }
      if (event.type !== "message_update") return;
      const assistantEvent = event.assistantMessageEvent;
      if (typeof assistantEvent !== "object" || assistantEvent === null) return;
      const nested = assistantEvent as Record<string, unknown>;
      const delta = nested.delta;
      if (typeof delta !== "string") return;
      if (nested.type === "text_delta") {
        text += delta;
        push({ type: "text_delta", requestId: request.requestId, model: request.model, delta });
      } else if (nested.type === "thinking_delta") {
        push({ type: "thinking_delta", requestId: request.requestId, model: request.model, delta });
      }
    });
    const abort = () => { void session.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    let completed = false;
    void session.prompt(renderMessages(request.messages)).then(() => {
      if (signal?.aborted) {
        push({ type: "error", requestId: request.requestId, message: "Request was aborted" });
      } else {
        push({ type: "done", result: {
          requestId: request.requestId,
          model: request.model,
          text,
          finishReason: "stop",
          ...(usage === undefined ? {} : { usage }),
          ...(thinking === undefined ? {} : { effectiveThinking: thinking === "off" ? "off" : thinking }),
        } });
      }
      push({ type: "close" });
    }).catch((error: unknown) => {
      push({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
      push({ type: "close" });
    });

    try {
      while (true) {
        const item = await next();
        if (item.type === "close") { completed = true; return; }
        yield item;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (!completed) await session.abort();
      session.dispose();
    }
  }
}

export class PiHttpTextAdapter {
  constructor(private readonly createSession: HttpPiSessionFactory) {}

  async complete(request: NormalizedChatRequest, signal?: AbortSignal): Promise<NormalizedChatResult> {
    if (request.stream) throw new HttpProtocolError("Streaming is not part of the non-stream adapter", "http_unsupported");
    if (request.messages.length === 0) throw new HttpProtocolError("At least one message is required", "http_invalid_request");
    if (request.tools && request.tools.length > 0) throw new HttpProtocolError("Caller-provided tools require the continuation adapter", "http_unsupported");
    if (signal?.aborted) throw new HttpProtocolError("Request was aborted", "http_execution");

    const thinking = mapThinking(request.thinking);
    let session: PiSessionLike;
    try {
      session = await this.createSession({ requestId: request.requestId, model: request.model, thinking, ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }), signal });
    } catch (error) {
      throw new HttpProtocolError(`Could not create Pi session: ${error instanceof Error ? error.message : String(error)}`, "http_execution");
    }
    let text = "";
    let usage: UsageSnapshot | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent;
        if (typeof assistantEvent === "object" && assistantEvent !== null && (assistantEvent as Record<string, unknown>).type === "text_delta") {
          const delta = (assistantEvent as Record<string, unknown>).delta;
          if (typeof delta === "string") text += delta;
        }
      }
      usage = usageFromEvent(event) ?? usage;
    });
    const abort = () => { void session.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await session.prompt(renderMessages(request.messages));
      if (signal?.aborted) throw new HttpProtocolError("Request was aborted", "http_execution");
      return {
        requestId: request.requestId,
        model: request.model,
        text,
        finishReason: "stop",
        ...(usage === undefined ? {} : { usage }),
        ...(thinking === undefined ? {} : { effectiveThinking: thinking === "off" ? "off" : thinking }),
      };
    } catch (error) {
      if (error instanceof HttpProtocolError) throw error;
      throw new HttpProtocolError(`Pi execution failed: ${error instanceof Error ? error.message : String(error)}`, "http_execution");
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  }
}
