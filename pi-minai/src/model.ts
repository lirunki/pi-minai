import type { AvailableModel, ModelCapabilities, ModelReference } from "./contracts/common.js";
import { ContractValidationError, MinaiPiError } from "./errors.js";

export type ModelRequirement = Partial<ModelCapabilities> & {
  locality?: AvailableModel["locality"];
};

export interface ModelCatalogService {
  list(): AvailableModel[];
  get(reference: ModelReference): AvailableModel | undefined;
  filter(requirement?: ModelRequirement): AvailableModel[];
}

function key(reference: ModelReference): string { return `${reference.provider}/${reference.id}`; }

function validateModel(model: AvailableModel): AvailableModel {
  if (!model.provider.trim() || !model.id.trim()) throw new ContractValidationError("model.provider and model.id must be non-empty");
  if (model.description !== undefined && (typeof model.description !== "string" || model.description.trim() === "")) throw new ContractValidationError(`model ${key(model)} has invalid description`);
  if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) throw new ContractValidationError(`model ${key(model)} has invalid contextWindow`);
  if (!Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0) throw new ContractValidationError(`model ${key(model)} has invalid maxOutputTokens`);
  for (const capability of ["tools", "vision", "reasoning", "streaming"] as const) {
    if (typeof model.capabilities[capability] !== "boolean") throw new ContractValidationError(`model ${key(model)} has invalid ${capability} capability`);
  }
  if (model.quality !== undefined && (!Number.isFinite(model.quality) || model.quality < 0)) throw new ContractValidationError(`model ${key(model)} has invalid quality`);
  return model;
}

export class StaticModelCatalog implements ModelCatalogService {
  private readonly models: Map<string, AvailableModel>;

  constructor(models: AvailableModel[]) {
    const validated = models.map((model) => validateModel(structuredClone(model)));
    if (new Set(validated.map(key)).size !== validated.length) throw new ContractValidationError("model provider/id pairs must be unique");
    this.models = new Map(validated.map((model) => [key(model), model]));
  }

  list(): AvailableModel[] { return [...this.models.values()].map((model) => structuredClone(model)); }
  get(reference: ModelReference): AvailableModel | undefined { const model = this.models.get(key(reference)); return model ? structuredClone(model) : undefined; }

  filter(requirement: ModelRequirement = {}): AvailableModel[] {
    return this.list().filter((model) =>
      (requirement.locality === undefined || model.locality === requirement.locality) &&
      Object.entries(requirement).every(([capability, required]) => capability === "locality" || required !== true || model.capabilities[capability as keyof ModelCapabilities] === true),
    );
  }
}

export type ModelToolCall = { id: string; name: string; arguments: unknown };
export type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: ModelToolCall[] };

export type ModelToolDefinition = { name: string; description?: string; parameters: Record<string, unknown> };

export type ModelInvocation = {
  model: ModelReference;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  thinking?: "off" | "low" | "medium" | "high";
};

export type ModelResult = {
  model: ModelReference;
  text: string;
  finishReason?: "stop" | "length" | "tool_call" | "error";
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCalls?: ModelToolCall[];
};

export type ModelStreamEvent =
  | { type: "delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; toolCall: ModelToolCall }
  | { type: "done"; result: ModelResult };

export type ModelHostHealth = {
  state: "starting" | "ready" | "degraded" | "stopped" | "failed" | "unavailable";
  backend: "llama-serve" | "python-minai" | "openai";
  activeRequests?: number;
  queuedRequests?: number;
  model?: ModelReference;
  error?: string;
};

export interface ModelHostLifecycle {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  health(): Promise<ModelHostHealth>;
}

export interface ModelHostService {
  ready(reference: ModelReference): Promise<boolean>;
  invoke(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResult>;
  stream(invocation: ModelInvocation, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export type ModelInvoker = (invocation: ModelInvocation, signal?: AbortSignal) => Promise<ModelResult>;
export type ModelStreamer = (invocation: ModelInvocation, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>;

export class ModelUnavailableError extends MinaiPiError {
  constructor(reference: ModelReference, reason = "unavailable") {
    super(`Model ${key(reference)} is ${reason}`, "model_unavailable");
    this.name = "ModelUnavailableError";
  }
}

export class InMemoryModelHost implements ModelHostService {
  constructor(
    private readonly catalog: ModelCatalogService,
    private readonly invoker: ModelInvoker,
    private readonly streamer?: ModelStreamer,
  ) {}

  async ready(reference: ModelReference): Promise<boolean> {
    const model = this.catalog.get(reference);
    return model?.availability === "ready";
  }

  private requireReady(reference: ModelReference): void {
    const model = this.catalog.get(reference);
    if (!model) throw new ModelUnavailableError(reference, "unknown");
    if (model.availability !== "ready") throw new ModelUnavailableError(reference, model.availability);
  }

  async invoke(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResult> {
    this.requireReady(invocation.model);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return this.invoker(invocation, signal);
  }

  async *stream(invocation: ModelInvocation, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requireReady(invocation.model);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (this.streamer) {
      yield* this.streamer(invocation, signal);
      return;
    }
    const result = await this.invoker(invocation, signal);
    if (result.text) yield { type: "delta", text: result.text };
    yield { type: "done", result };
  }
}
