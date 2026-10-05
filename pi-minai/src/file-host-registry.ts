import { readFile } from "node:fs/promises";
import type { AvailableModel, ModelReference } from "./contracts/common.js";
import { ContractValidationError } from "./errors.js";
import { StaticModelCatalog, type ModelCatalogService, type ModelHostService } from "./model.js";
import { LlamaServeHost, RemoteOpenAiHost, type LlamaServeHostOptions } from "./llama-serve-host.js";
import { PythonMinaiHost, type PythonMinaiHostOptions } from "./python-host.js";

export type FileHostDefinition = ({ backend: "python-minai" } & PythonMinaiHostOptions) | ({ backend: "llama-serve" } & LlamaServeHostOptions) | ({ backend: "openai" } & LlamaServeHostOptions);
export type FileModelDefinition = AvailableModel & { host: string };
export type FileHostRegistryDocument = { hosts: Record<string, FileHostDefinition>; models: FileModelDefinition[] };
function key(reference: ModelReference): string { return `${reference.provider}/${reference.id}`; }
function fail(message: string): never { throw new ContractValidationError(`Invalid model host registry: ${message}`); }
function validate(document: unknown): FileHostRegistryDocument { if (typeof document !== "object" || document === null) return fail("root must be an object"); const value = document as Record<string, unknown>; if (typeof value.hosts !== "object" || value.hosts === null || Array.isArray(value.hosts)) return fail("hosts must be an object"); if (!Array.isArray(value.models)) return fail("models must be an array"); const hosts = value.hosts as Record<string, unknown>; for (const [id, raw] of Object.entries(hosts)) { if (!raw || typeof raw !== "object" || typeof (raw as Record<string, unknown>).backend !== "string" || typeof (raw as Record<string, unknown>).baseUrl !== "string") return fail(`host ${id} must define backend and baseUrl`); const backend = (raw as Record<string, unknown>).backend; if (backend !== "python-minai" && backend !== "llama-serve" && backend !== "openai") return fail(`host ${id} has unsupported backend ${String(backend)}`); } const models = value.models.map((raw, index) => { if (!raw || typeof raw !== "object") return fail(`model ${index} must be an object`); const model = raw as Record<string, unknown>; if (typeof model.host !== "string" || !hosts[model.host]) return fail(`model ${index} references an unknown host`); if (typeof model.provider !== "string" || typeof model.id !== "string") return fail(`model ${index} must define provider and id`); return structuredClone(model) as unknown as FileModelDefinition; }); if (new Set(models.map(key)).size !== models.length) return fail("model provider/id pairs must be unique"); return { hosts: structuredClone(hosts) as Record<string, FileHostDefinition>, models }; }

export class FileModelHostRegistry {
  private constructor(private readonly definitions: FileHostRegistryDocument, private readonly catalog: ModelCatalogService, private readonly hosters: Map<string, ModelHostService>) {}
  static async load(path: string): Promise<FileModelHostRegistry> { let parsed: unknown; try { parsed = JSON.parse(await readFile(path, "utf8")); } catch (error) { throw new ContractValidationError(`Could not read model host registry: ${error instanceof Error ? error.message : String(error)}`); } const definitions = validate(parsed); const hosters = new Map<string, ModelHostService>(); for (const [id, definition] of Object.entries(definitions.hosts)) hosters.set(id, definition.backend === "python-minai" ? new PythonMinaiHost(definition) : definition.backend === "openai" ? new RemoteOpenAiHost(definition) : new LlamaServeHost(definition)); const catalog = new StaticModelCatalog(definitions.models); return new FileModelHostRegistry(definitions, catalog, hosters); }
  listHosts(): string[] { return Object.keys(this.definitions.hosts); }
  listModels(): AvailableModel[] { return this.catalog.list(); }
  getModel(reference: ModelReference): AvailableModel | undefined { return this.catalog.get(reference); }
  getHost(id: string): ModelHostService { const host = this.hosters.get(id); if (!host) throw new ContractValidationError(`Unknown model host: ${id}`); return host; }
  getModelHostId(reference: ModelReference): string { const model = this.definitions.models.find((candidate) => key(candidate) === key(reference)); if (!model) throw new ContractValidationError(`Unknown model: ${key(reference)}`); return model.host; }
  getModelHost(reference: ModelReference): ModelHostService { return this.getHost(this.getModelHostId(reference)); }
  async start(): Promise<void> { for (const host of this.hosters.values()) await (host as ModelHostService & { start?: () => Promise<void> }).start?.(); }
  async stop(): Promise<void> { for (const host of [...this.hosters.values()].reverse()) await (host as ModelHostService & { stop?: () => Promise<void> }).stop?.(); }
  catalogService(): ModelCatalogService { return this.catalog; }
}
