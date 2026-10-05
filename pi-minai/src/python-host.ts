import type { ModelReference } from "./contracts/common.js";
import { MinaiPiError } from "./errors.js";
import type { ModelHostHealth, ModelHostService, ModelInvocation, ModelResult, ModelStreamEvent, ModelToolCall } from "./model.js";
import { ModelHostProcess, type ModelHostProcessOptions } from "./model-host-process.js";

export type PythonMinaiHostOptions = {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  healthPath?: string;
  generatePath?: string;
  streamPath?: string;
  process?: ModelHostProcessOptions;
};

export class PythonMinaiHostError extends MinaiPiError {
  constructor(message: string, code: "python_host_http" | "python_host_protocol" | "python_host_unavailable") { super(message, code); this.name = "PythonMinaiHostError"; }
}

type PythonHealth = { status?: string; state?: string; model?: ModelReference; active_requests?: number; queued_requests?: number; error?: string };
type PythonEvent = { id?: string; type?: string; text?: string; tool_call?: ModelToolCall; tool_calls?: ModelToolCall[]; finish_reason?: ModelResult["finishReason"]; input_tokens?: number; output_tokens?: number; total_tokens?: number; reasoning_tokens?: number; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };

function url(base: string, path: string): string { return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`; }
function headers(options: PythonMinaiHostOptions, content = false): Headers { const result = new Headers(options.headers); if (content) result.set("content-type", "application/json"); return result; }
function protocolError(response: Response): PythonMinaiHostError { return new PythonMinaiHostError(`Python host returned HTTP ${response.status}`, "python_host_http"); }
function usage(event: PythonEvent): ModelResult["usage"] | undefined { const value = event.usage ?? event; const inputTokens = value.input_tokens; const outputTokens = value.output_tokens; if (inputTokens === undefined && outputTokens === undefined && value.total_tokens === undefined) return undefined; return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) }; }
function invocationBody(invocation: ModelInvocation): Record<string, unknown> { return { id: `${invocation.model.provider}/${invocation.model.id}`, model: invocation.model, messages: invocation.messages, ...(invocation.tools === undefined ? {} : { tools: invocation.tools }), ...(invocation.temperature === undefined ? {} : { temperature: invocation.temperature }), ...(invocation.maxOutputTokens === undefined ? {} : { max_output_tokens: invocation.maxOutputTokens }), ...(invocation.thinking === undefined ? {} : { thinking: invocation.thinking }) }; }

export class PythonMinaiHost implements ModelHostService {
  private readonly options: Required<Pick<PythonMinaiHostOptions, "healthPath" | "generatePath" | "streamPath">> & PythonMinaiHostOptions;
  private readonly process?: ModelHostProcess;
  constructor(options: PythonMinaiHostOptions) { this.options = { ...options, healthPath: options.healthPath ?? "/health", generatePath: options.generatePath ?? "/v1/generate", streamPath: options.streamPath ?? "/v1/generate/stream" }; if (options.process) this.process = new ModelHostProcess(options.process, async () => (await this.health()).state === "ready"); }
  async start(): Promise<void> { await this.process?.start(); }
  async stop(): Promise<void> { await this.process?.stop(); }
  private get fetch(): typeof globalThis.fetch { return this.options.fetch ?? globalThis.fetch; }
  async health(): Promise<ModelHostHealth> { try { const response = await this.fetch(url(this.options.baseUrl, this.options.healthPath), { headers: headers(this.options) }); if (!response.ok) throw protocolError(response); const value = await response.json() as PythonHealth; const state = value.state === "ready" || value.status === "ok" ? "ready" : value.state === "failed" ? "failed" : "degraded"; return { state, backend: "python-minai", ...(value.model === undefined ? {} : { model: value.model }), ...(value.active_requests === undefined ? {} : { activeRequests: value.active_requests }), ...(value.queued_requests === undefined ? {} : { queuedRequests: value.queued_requests }), ...(value.error === undefined ? {} : { error: value.error }) }; } catch (error) { if (error instanceof PythonMinaiHostError) throw error; throw new PythonMinaiHostError(`Python host is unavailable: ${error instanceof Error ? error.message : String(error)}`, "python_host_unavailable"); } }
  async ready(_reference: ModelReference): Promise<boolean> { try { return (await this.health()).state === "ready"; } catch { return false; } }
  async invoke(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResult> { const response = await this.fetch(url(this.options.baseUrl, this.options.generatePath), { method: "POST", headers: headers(this.options, true), body: JSON.stringify(invocationBody(invocation)), signal }); if (!response.ok) throw protocolError(response); let value: Record<string, unknown>; try { value = await response.json() as Record<string, unknown>; } catch (error) { throw new PythonMinaiHostError(`Invalid Python host JSON: ${error instanceof Error ? error.message : String(error)}`, "python_host_protocol"); } const text = value.text; if (typeof text !== "string") throw new PythonMinaiHostError("Python host response is missing text", "python_host_protocol"); const rawUsage = value.usage as PythonEvent["usage"] | undefined; const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls as ModelToolCall[] : []; return { model: invocation.model, text, finishReason: value.finish_reason as ModelResult["finishReason"] | undefined, ...(toolCalls.length === 0 ? {} : { toolCalls }), ...(rawUsage === undefined ? {} : { usage: { inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens } }) }; }
  async *stream(invocation: ModelInvocation, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> { const response = await this.fetch(url(this.options.baseUrl, this.options.streamPath), { method: "POST", headers: headers(this.options, true), body: JSON.stringify(invocationBody(invocation)), signal }); if (!response.ok) throw protocolError(response); if (!response.body) throw new PythonMinaiHostError("Python host returned no stream body", "python_host_protocol"); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; try { while (true) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { if (!line.trim()) continue; let event: PythonEvent; try { event = JSON.parse(line) as PythonEvent; } catch (error) { throw new PythonMinaiHostError(`Invalid Python host event: ${error instanceof Error ? error.message : String(error)}`, "python_host_protocol"); } if (event.type === "delta" && typeof event.text === "string") yield { type: "delta", text: event.text }; else if (event.type === "thinking_delta" && typeof event.text === "string") yield { type: "thinking_delta", text: event.text }; else if (event.type === "tool_call" && event.tool_call) yield { type: "tool_call", toolCall: event.tool_call }; else if (event.type === "done") yield { type: "done", result: { model: invocation.model, text: "", finishReason: event.finish_reason ?? "stop", ...(usage(event) === undefined ? {} : { usage: usage(event) }) } }; } } if (buffer.trim()) { const event = JSON.parse(buffer) as PythonEvent; if (event.type === "delta" && typeof event.text === "string") yield { type: "delta", text: event.text }; } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
}
