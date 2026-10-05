import type { ModelReference } from "./contracts/common.js";
import { MinaiPiError } from "./errors.js";
import type { ModelHostHealth, ModelHostService, ModelInvocation, ModelResult, ModelStreamEvent } from "./model.js";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelHostProcess, type ModelHostProcessOptions } from "./model-host-process.js";

export type LlamaServeProcessOptions = ModelHostProcessOptions & {
  /** Hugging Face repo to auto-download into cacheDir on first start; overrides a `modelPath` in args. */
  hfRepo?: string;
  /** Exact file inside hfRepo (passed as --hf-file). */
  hfFile?: string;
  /** Download cache folder; exposed to llama-server as LLAMA_CACHE. */
  cacheDir?: string;
  /** When true the process starts with the runtime instead of on first model use. */
  eager?: boolean;
};
export type LlamaServeHostOptions = { baseUrl: string; fetch?: typeof globalThis.fetch; headers?: Record<string, string>; apiKeyEnv?: string; /** Provider name in the Pi model catalog (~/.pi/agent/models.json) whose apiKey is used when apiKeyEnv is unset. */ apiKeyCatalog?: string; healthPath?: string; chatPath?: string; process?: LlamaServeProcessOptions };
export class LlamaServeHostError extends MinaiPiError {
  constructor(message: string, code: "llama_serve_http" | "llama_serve_protocol" | "llama_serve_unavailable") { super(message, code); this.name = "LlamaServeHostError"; }
}
function endpoint(base: string, path: string): string { return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`; }
/** Reads a provider credential from the shared Pi model catalog; never cached, never logged. */
export function piCatalogApiKey(provider: string): string | undefined {
  const directory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  try {
    const providers = JSON.parse(readFileSync(path.join(directory, "models.json"), "utf8")).providers ?? {};
    const key = (providers[provider] ?? {})["apiKey"];
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}
function requestHeaders(options: LlamaServeHostOptions): Headers {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  const key = options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined;
  if (options.apiKeyEnv && !key && !options.apiKeyCatalog) throw new LlamaServeHostError(`Missing API key: set ${options.apiKeyEnv} for this model host`, "llama_serve_unavailable");
  const resolved = key ?? (options.apiKeyCatalog ? piCatalogApiKey(options.apiKeyCatalog) : undefined);
  if (options.apiKeyEnv && !key && options.apiKeyCatalog && !resolved) throw new LlamaServeHostError(`Missing API key: set ${options.apiKeyEnv}, or add providers.${options.apiKeyCatalog}.apiKey to the Pi model catalog`, "llama_serve_unavailable");
  if (resolved) headers.set("authorization", `Bearer ${resolved}`);
  return headers;
}
export function hfSpawnOptions(process: LlamaServeProcessOptions): ModelHostProcessOptions {
  const source = process.hfRepo ? (process.hfFile ? ["-hf", process.hfRepo, "-hff", process.hfFile] : ["-hf", process.hfRepo]) : [];
  return {
    ...process,
    args: [...source, ...(process.args ?? [])],
    ...(process.cacheDir ? { env: { ...(process.env ?? {}), LLAMA_CACHE: process.cacheDir } } : {}),
  };
}
function body(invocation: ModelInvocation, stream: boolean): Record<string, unknown> { return { model: invocation.model.id, messages: invocation.messages, stream, ...(invocation.tools === undefined ? {} : { tools: invocation.tools.map((tool) => ({ type: "function", function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.parameters } })) }), ...(invocation.temperature === undefined ? {} : { temperature: invocation.temperature }), ...(invocation.maxOutputTokens === undefined ? {} : { max_tokens: invocation.maxOutputTokens }), ...(invocation.thinking === undefined || invocation.thinking === "off" ? {} : { reasoning_effort: invocation.thinking }) }; }
function httpError(response: Response, baseUrl?: string): LlamaServeHostError {
  let host = "";
  try { host = baseUrl ? `${new URL(baseUrl).host} ` : ""; } catch { /* keep the message simple */ }
  return new LlamaServeHostError(`llama-serve ${host}returned HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ""}`, "llama_serve_http");
}
function usage(value: Record<string, unknown>): ModelResult["usage"] | undefined { const candidate = value.usage; if (typeof candidate !== "object" || candidate === null) return undefined; const u = candidate as Record<string, unknown>; const inputTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined; const outputTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined; if (inputTokens === undefined && outputTokens === undefined) return undefined; return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) }; }

export class LlamaServeHost implements ModelHostService {
  protected readonly fetcher: typeof globalThis.fetch;
  protected readonly options: LlamaServeHostOptions;
  private readonly process?: ModelHostProcess;
  private readonly eager: boolean;
  private processStarted = false;
  constructor(options: LlamaServeHostOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.eager = options.process?.eager === true;
    if (options.process) this.process = new ModelHostProcess(hfSpawnOptions(options.process), () => this.endpointReady());
  }
  get managedProcess(): ModelHostProcess | undefined { return this.process; }
  private endpointReady(): Promise<boolean> { return this.ready({ provider: "llama-serve", id: "*" }); }
  private async ensureProcess(): Promise<void> {
    if (!this.process || this.processStarted) return;
    this.processStarted = true;
    if (this.options.process?.cacheDir) { try { mkdirSync(this.options.process.cacheDir, { recursive: true }); } catch { /* llama-server surfaces cache errors itself */ } }
    await this.process.start();
  }
  async start(): Promise<void> { if (this.process && this.eager) { this.processStarted = true; await this.process.start(); } }
  async stop(): Promise<void> { await this.process?.stop(); }
  async ready(reference: ModelReference): Promise<boolean> {
    if (this.process && !this.processStarted) return true; // lazily started: selectable, spawns on first use
    try { const response = await this.fetcher(endpoint(this.options.baseUrl, this.options.healthPath ?? "/health"), { headers: requestHeaders(this.options) }); return response.ok; } catch { return false; }
  }
  async health(): Promise<ModelHostHealth> { const ready = await this.ready({ provider: "llama-serve", id: "*" }); return { state: ready ? "ready" : "unavailable", backend: "llama-serve" }; }
  async invoke(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResult> { await this.ensureProcess(); const response = await this.fetcher(endpoint(this.options.baseUrl, this.options.chatPath ?? "/v1/chat/completions"), { method: "POST", headers: requestHeaders(this.options), body: JSON.stringify(body(invocation, false)), signal }); if (!response.ok) throw httpError(response, this.options.baseUrl); let value: Record<string, unknown>; try { value = await response.json() as Record<string, unknown>; } catch (error) { throw new LlamaServeHostError(`Invalid llama-serve JSON: ${error instanceof Error ? error.message : String(error)}`, "llama_serve_protocol"); } const choices = Array.isArray(value.choices) ? value.choices : []; const first = choices[0] as Record<string, unknown> | undefined; const message = first?.message as Record<string, unknown> | undefined; if (typeof message?.content !== "string") throw new LlamaServeHostError("llama-serve response is missing message content", "llama_serve_protocol"); const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []; const toolCalls = rawCalls.map((raw) => { const call = raw as Record<string, unknown>; const fn = call.function as Record<string, unknown>; let args: unknown = fn.arguments ?? {}; try { if (typeof args === "string") args = JSON.parse(args); } catch { /* preserve malformed arguments for the caller */ } return { id: String(call.id ?? ""), name: String(fn.name ?? ""), arguments: args }; }); return { model: invocation.model, text: message.content, finishReason: first?.finish_reason as ModelResult["finishReason"] | undefined, ...(toolCalls.length === 0 ? {} : { toolCalls }), ...(usage(value) === undefined ? {} : { usage: usage(value) }) }; }
  async *stream(invocation: ModelInvocation, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> { await this.ensureProcess(); const response = await this.fetcher(endpoint(this.options.baseUrl, this.options.chatPath ?? "/v1/chat/completions"), { method: "POST", headers: requestHeaders(this.options), body: JSON.stringify(body(invocation, true)), signal }); if (!response.ok) throw httpError(response, this.options.baseUrl); if (!response.body) throw new LlamaServeHostError("llama-serve returned no stream body", "llama_serve_protocol"); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; try { while (true) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { const event = this.parseLine(line, invocation.model); if (event) yield event; } } if (buffer.trim()) { const event = this.parseLine(buffer, invocation.model); if (event) yield event; } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
  private parseLine(line: string, model: ModelReference): ModelStreamEvent | undefined { const trimmed = line.trim(); if (!trimmed || !trimmed.startsWith("data:")) return undefined; const payload = trimmed.slice(5).trim(); if (payload === "[DONE]") return { type: "done", result: { model, text: "", finishReason: "stop" } }; let value: Record<string, unknown>; try { value = JSON.parse(payload) as Record<string, unknown>; } catch (error) { throw new LlamaServeHostError(`Invalid llama-serve SSE event: ${error instanceof Error ? error.message : String(error)}`, "llama_serve_protocol"); } const choices = Array.isArray(value.choices) ? value.choices : []; const first = choices[0] as Record<string, unknown> | undefined; const delta = first?.delta as Record<string, unknown> | undefined; const thinking = delta?.reasoning_content ?? delta?.thinking; if (typeof thinking === "string") return { type: "thinking_delta", text: thinking }; const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []; const call = calls[0] as Record<string, unknown> | undefined; const fn = call?.function as Record<string, unknown> | undefined; if (call && fn?.name && fn.arguments !== undefined) { let args: unknown = fn.arguments; try { if (typeof args === "string") args = JSON.parse(args); } catch { /* partial arguments are handled by the host protocol */ } return { type: "tool_call", toolCall: { id: String(call.id ?? ""), name: String(fn.name), arguments: args } }; } if (typeof delta?.content === "string") return { type: "delta", text: delta.content }; if (first?.finish_reason) return { type: "done", result: { model, text: "", finishReason: first.finish_reason as ModelResult["finishReason"], ...(usage(value) === undefined ? {} : { usage: usage(value) }) } }; return undefined; }
}

/** Remote OpenAI-compatible host: always lazy (no managed process), reachable-endpoint health. */
export class RemoteOpenAiHost extends LlamaServeHost {
  private readonly probe: typeof globalThis.fetch;
  constructor(options: LlamaServeHostOptions) {
    super({ ...options, chatPath: options.chatPath ?? "/chat/completions", healthPath: options.healthPath ?? "/models" });
    this.probe = options.fetch ?? globalThis.fetch;
  }
  async ready(_reference: ModelReference): Promise<boolean> {
    try { const response = await this.probe(endpoint(this.options.baseUrl, this.options.healthPath ?? "/models"), { headers: requestHeaders(this.options), signal: AbortSignal.timeout(5_000) }); return response.status !== 401 && response.status !== 403; } catch { return false; }
  }
}
