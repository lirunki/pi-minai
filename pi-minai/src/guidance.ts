import type { GuidanceDefinition } from "./contracts/common.js";
import type { ChoiceQuestion, SystemOneService } from "./contracts/system-one.js";
import { ContractValidationError, ServiceUnavailableError } from "./errors.js";

export type GuidanceInstance = {
  modelClassRegex?: string;
  instructions: string;
  instructionsFinal?: string;
  temperature?: number;
  rank?: number;
};

export type GuidanceRecord = GuidanceDefinition & {
  instances: GuidanceInstance[];
};

export interface GuidanceCatalogService {
  list(): GuidanceRecord[];
  get(id: string): GuidanceRecord | undefined;
  resolve(id: string, model: string): GuidanceInstance;
}

function validateRecord(record: GuidanceRecord): GuidanceRecord {
  if (!record.id || !/^[A-Za-z0-9_\-]+$/.test(record.id)) throw new ContractValidationError("guidance.id must be a safe non-empty identifier");
  if (!record.description.trim()) throw new ContractValidationError(`guidance.${record.id}.description must be non-empty`);
  if (!Array.isArray(record.instances) || record.instances.length === 0) throw new ContractValidationError(`guidance.${record.id}.instances must not be empty`);
  for (const [index, instance] of record.instances.entries()) {
    if (!instance.instructions.trim()) throw new ContractValidationError(`guidance.${record.id}.instances[${index}].instructions must be non-empty`);
    if (instance.modelClassRegex !== undefined) {
      try { new RegExp(instance.modelClassRegex); } catch (error) { throw new ContractValidationError(`guidance.${record.id}.instances[${index}].modelClassRegex is invalid`); }
    }
  }
  return record;
}

export class StaticGuidanceCatalog implements GuidanceCatalogService {
  private readonly records: Map<string, GuidanceRecord>;

  constructor(records: GuidanceRecord[]) {
    const validated = records.map((record) => validateRecord(structuredClone(record)));
    if (new Set(validated.map((record) => record.id)).size !== validated.length) throw new ContractValidationError("guidance IDs must be unique");
    this.records = new Map(validated.map((record) => [record.id, record]));
  }

  list(): GuidanceRecord[] { return [...this.records.values()].map((record) => structuredClone(record)); }
  get(id: string): GuidanceRecord | undefined { const record = this.records.get(id); return record ? structuredClone(record) : undefined; }

  resolve(id: string, model: string): GuidanceInstance {
    const record = this.records.get(id);
    if (!record) throw new ContractValidationError(`Unknown guidance: ${id}`);
    const matching = record.instances.filter((instance) => instance.modelClassRegex === undefined || new RegExp(instance.modelClassRegex).test(model));
    if (matching.length === 0) throw new ContractValidationError(`No guidance instance matches ${id} for model ${model}`);
    return structuredClone([...matching].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))[0]!);
  }
}

export type GuidanceSelectionInput = {
  query: string;
  model: string;
  explicitGuidance?: string;
  taskQuery?: string;
  parentRole?: string;
  hasCode?: boolean;
  hasAttachments?: boolean;
  hasTools?: boolean;
  contextSizeClass?: string;
  runtime?: Record<string, unknown>;
};

export type GuidanceSelection = {
  id: string;
  source: "explicit" | "jev" | "fallback";
  confidence?: number;
  probabilities?: Record<string, number>;
};

export interface GuidanceSelectorService {
  select(input: GuidanceSelectionInput, signal?: AbortSignal): Promise<GuidanceSelection>;
}

export class GuidanceSelector implements GuidanceSelectorService {
  constructor(
    private readonly catalog: GuidanceCatalogService,
    private readonly systemOne?: SystemOneService,
    private readonly options: { fallbackId?: string; minConfidence?: number } = {},
  ) {}

  async select(input: GuidanceSelectionInput, signal?: AbortSignal): Promise<GuidanceSelection> {
    if (input.explicitGuidance && this.catalog.get(input.explicitGuidance)) {
      return { id: input.explicitGuidance, source: "explicit" };
    }

    if (this.systemOne) {
      const criteria = Object.fromEntries(this.catalog.list().map((guidance) => [guidance.id, guidance.description]));
      const question: ChoiceQuestion = {
        type: "choice",
        instructions: "Choose the single guidance that best fits the request.",
        criteria,
      };
      try {
        const response = await this.systemOne.systemOne({
          state: {
            query: input.query,
            ...(input.taskQuery === undefined ? {} : { taskQuery: input.taskQuery }),
            ...(input.parentRole === undefined ? {} : { parentRole: input.parentRole }),
            ...(input.hasCode === undefined ? {} : { hasCode: input.hasCode }),
            ...(input.hasAttachments === undefined ? {} : { hasAttachments: input.hasAttachments }),
            ...(input.hasTools === undefined ? {} : { hasTools: input.hasTools }),
            ...(input.contextSizeClass === undefined ? {} : { contextSizeClass: input.contextSizeClass }),
            ...input.runtime,
          },
          model: input.model,
          questions: { guidance: question },
        }, signal);
        const answer = response.answers.guidance;
        if (answer.type === "choice" && this.catalog.get(answer.choice) && answer.confidence >= (this.options.minConfidence ?? 0.5)) {
          return { id: answer.choice, source: "jev", confidence: answer.confidence, probabilities: answer.probabilities };
        }
      } catch (error) {
        if (error instanceof ServiceUnavailableError) throw error;
      }
    }

    const fallbackId = this.options.fallbackId ?? "general_qa";
    const fallback = this.catalog.get(fallbackId) ?? this.catalog.list()[0];
    if (!fallback) throw new ContractValidationError("Cannot select guidance from an empty catalog");
    return { id: fallback.id, source: "fallback" };
  }
}
