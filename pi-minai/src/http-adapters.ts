import { HttpProtocolError, type HttpMessage, type HttpToolDefinition, type NormalizedChatRequest, type NormalizedChatResult, type NormalizedChatStreamEvent } from "./http-protocol.js";
import type { ModelReference } from "./contracts/common.js";

export type OpenAIChatBody = {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string | null | Array<{ type?: string; text?: string }>; name?: string; tool_call_id?: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }>;
  stream?: boolean;
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: "none" | "low" | "medium" | "high";
};

export type OllamaChatBody = {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }>;
  stream?: boolean;
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
  options?: { temperature?: number; num_predict?: number };
  think?: boolean | "low" | "medium" | "high";
};

export type OllamaGenerateBody = {
  model: string;
  prompt: string;
  system?: string;
  stream?: boolean;
  options?: { temperature?: number; num_predict?: number };
  think?: boolean | "low" | "medium" | "high";
};

function modelReference(value: string): ModelReference {
  const slash = value.indexOf("/");
  return slash < 1 ? { provider: "default", id: value } : { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function contentText(value: OpenAIChatBody["messages"][number]["content"]): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return value.filter((part) => part.type === undefined || part.type === "text").map((part) => part.text ?? "").join("");
}

function messages(value: OpenAIChatBody["messages"]): HttpMessage[] {
  return value.map((message) => ({ role: message.role, content: contentText(message.content), ...(message.name === undefined ? {} : { name: message.name }), ...(message.tool_call_id === undefined ? {} : { toolCallId: message.tool_call_id }) }));
}

function tools(value: OpenAIChatBody["tools"] | OllamaChatBody["tools"]): HttpToolDefinition[] | undefined {
  if (!value) return undefined;
  return value.map((tool) => ({ name: tool.function.name, ...(tool.function.description === undefined ? {} : { description: tool.function.description }), parameters: tool.function.parameters ?? {} }));
}

export function parseOpenAIChat(body: OpenAIChatBody, requestId: string): NormalizedChatRequest {
  if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) throw new HttpProtocolError("Invalid OpenAI chat request", "http_invalid_request");
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0)) throw new HttpProtocolError("Invalid temperature", "http_invalid_request");
  return {
    protocol: "openai", requestId, model: modelReference(body.model), messages: messages(body.messages),
    ...(tools(body.tools) === undefined ? {} : { tools: tools(body.tools) }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...((body.max_completion_tokens ?? body.max_tokens) === undefined ? {} : { maxOutputTokens: body.max_completion_tokens ?? body.max_tokens }),
    ...(body.reasoning_effort === undefined ? {} : { thinking: { effort: body.reasoning_effort } }),
    stream: body.stream ?? false,
  };
}

export function parseOllamaChat(body: OllamaChatBody, requestId: string): NormalizedChatRequest {
  if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) throw new HttpProtocolError("Invalid Ollama chat request", "http_invalid_request");
  return {
    protocol: "ollama", requestId, model: { provider: "ollama", id: body.model }, messages: body.messages.map((message) => ({ role: message.role, content: message.content })),
    ...(tools(body.tools) === undefined ? {} : { tools: tools(body.tools) }),
    ...(body.options?.temperature === undefined ? {} : { temperature: body.options.temperature }),
    ...(body.options?.num_predict === undefined ? {} : { maxOutputTokens: body.options.num_predict }),
    ...(body.think === undefined ? {} : { thinking: { think: body.think } }),
    stream: body.stream ?? true,
  };
}

export function parseOllamaGenerate(body: OllamaGenerateBody, requestId: string): NormalizedChatRequest {
  if (!body || typeof body.model !== "string" || typeof body.prompt !== "string") throw new HttpProtocolError("Invalid Ollama generate request", "http_invalid_request");
  const messages: HttpMessage[] = [
    ...(body.system === undefined ? [] : [{ role: "system" as const, content: body.system }]),
    { role: "user" as const, content: body.prompt },
  ];
  return {
    protocol: "ollama", requestId, model: { provider: "ollama", id: body.model }, messages,
    ...(body.options?.temperature === undefined ? {} : { temperature: body.options.temperature }),
    ...(body.options?.num_predict === undefined ? {} : { maxOutputTokens: body.options.num_predict }),
    ...(body.think === undefined ? {} : { thinking: { think: body.think } }),
    stream: body.stream ?? true,
  };
}

function usageOpenAI(usage?: NormalizedChatResult["usage"]): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.promptTokens === undefined ? {} : { prompt_tokens: usage.promptTokens }),
    ...(usage.completionTokens === undefined ? {} : { completion_tokens: usage.completionTokens }),
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
  };
}

export function serializeOpenAIChat(result: NormalizedChatResult): Record<string, unknown> {
  return {
    id: `chatcmpl-${result.requestId}`,
    object: "chat.completion",
    model: `${result.model.provider}/${result.model.id}`,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.finishReason }],
    ...(usageOpenAI(result.usage) === undefined ? {} : { usage: usageOpenAI(result.usage) }),
  };
}

export function serializeOllamaChat(result: NormalizedChatResult): Record<string, unknown> {
  return { model: result.model.id, created_at: new Date().toISOString(), message: { role: "assistant", content: result.text }, done: true, done_reason: result.finishReason, ...(result.usage?.promptTokens === undefined ? {} : { prompt_eval_count: result.usage.promptTokens }), ...(result.usage?.completionTokens === undefined ? {} : { eval_count: result.usage.completionTokens }) };
}

export function serializeOllamaGenerate(result: NormalizedChatResult): Record<string, unknown> {
  return { model: result.model.id, created_at: new Date().toISOString(), response: result.text, done: true, done_reason: result.finishReason, ...(result.usage?.promptTokens === undefined ? {} : { prompt_eval_count: result.usage.promptTokens }), ...(result.usage?.completionTokens === undefined ? {} : { eval_count: result.usage.completionTokens }) };
}

export function serializeOpenAIStream(event: NormalizedChatStreamEvent): Record<string, unknown> {
  if (event.type === "text_delta") return { id: `chatcmpl-${event.requestId}`, object: "chat.completion.chunk", model: `${event.model.provider}/${event.model.id}`, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] };
  if (event.type === "thinking_delta") return { id: `chatcmpl-${event.requestId}`, object: "chat.completion.chunk", model: `${event.model.provider}/${event.model.id}`, choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }] };
  if (event.type === "error") return { error: { message: event.message, type: "server_error" } };
  return { id: `chatcmpl-${event.result.requestId}`, object: "chat.completion.chunk", model: `${event.result.model.provider}/${event.result.model.id}`, choices: [{ index: 0, delta: event.result.finishReason === "error" && event.result.text ? { content: event.result.text } : {}, finish_reason: event.result.finishReason }], ...(usageOpenAI(event.result.usage) === undefined ? {} : { usage: usageOpenAI(event.result.usage) }) };
}

export function serializeOllamaStream(event: NormalizedChatStreamEvent, generate = false): Record<string, unknown> {
  if (event.type === "text_delta") return generate ? { model: event.model.id, created_at: new Date().toISOString(), response: event.delta, done: false } : { model: event.model.id, created_at: new Date().toISOString(), message: { role: "assistant", content: event.delta }, done: false };
  if (event.type === "thinking_delta") return generate ? { model: event.model.id, created_at: new Date().toISOString(), thinking: event.delta, done: false } : { model: event.model.id, created_at: new Date().toISOString(), message: { role: "assistant", thinking: event.delta }, done: false };
  if (event.type === "error") return { error: event.message, done: true };
  return generate ? serializeOllamaGenerate(event.result) : serializeOllamaChat(event.result);
}
