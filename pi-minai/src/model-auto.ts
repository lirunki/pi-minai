import type { AvailableModel, ModelReference } from "./contracts/common.js";
import type { SystemOneService } from "./contracts/system-one.js";
import { MinaiPiError, ServiceUnavailableError } from "./errors.js";
import type { ModelCatalogService, ModelRequirement } from "./model.js";
import type { TextEmbeddingService } from "./model-embeddings.js";

export type ExplicitModelPolicy = "strict" | "route";

export type ModelSelectionInput = {
  query: string;
  classifierModel?: string;
  requestedModel: "auto" | ModelReference;
  requirements?: ModelRequirement;
  guidanceId?: string;
  guidanceDescription?: string;
  localityPreference?: AvailableModel["locality"];
  explicitPolicy?: ExplicitModelPolicy;
  minConfidence?: number;
  runtime?: Record<string, unknown>;
};

export type ModelSelection = {
  model: ModelReference;
  source: "explicit" | "single" | "embedding" | "jev" | "fallback";
  confidence?: number;
  probabilities?: Record<string, number>;
  candidates: ModelReference[];
  /** Full preference order: `model` first, then the fallback chain in priority order. */
  order: ModelReference[];
};

export type ModelAutoSelectorOptions = {
  embeddingService?: TextEmbeddingService;
  embeddingMinConfidence?: number;
  embeddingTemperature?: number;
};

export interface ModelSelectorService {
  select(input: ModelSelectionInput, signal?: AbortSignal): Promise<ModelSelection>;
}

export class ModelSelectionError extends MinaiPiError {
  constructor(message: string, code: "model_no_candidates" | "model_explicit_invalid" | "model_selection") {
    super(message, code);
    this.name = "ModelSelectionError";
  }
}

function referenceKey(model: ModelReference): string { return `${model.provider}/${model.id}`; }

/** Order candidates by descending probability (stable by reference key on ties). */
function orderByProbability(candidates: ModelReference[], probabilities: Record<string, number> | undefined): ModelReference[] {
  if (!probabilities) return candidates;
  return [...candidates].sort((a, b) => (probabilities[referenceKey(b)] ?? 0) - (probabilities[referenceKey(a)] ?? 0) || referenceKey(a).localeCompare(referenceKey(b)));
}

function candidateDescription(model: AvailableModel): string {
  const capabilities = Object.entries(model.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "basic";
  const details = [model.description?.trim(), model.provider, model.id, model.locality, model.availability, `capabilities: ${capabilities}`, `context: ${model.contextWindow}`, `max output: ${model.maxOutputTokens}`, ...(model.quality === undefined ? [] : [`quality: ${model.quality}`])].filter(Boolean).join("; ");
  return details;
}

function rank(models: AvailableModel[], locality?: AvailableModel["locality"]): AvailableModel[] {
  return [...models].sort((a, b) => {
    const readyScore = Number(b.availability === "ready") - Number(a.availability === "ready");
    if (readyScore) return readyScore;
    const preferred = Number(b.locality === locality) - Number(a.locality === locality);
    if (preferred) return preferred;
    const quality = (b.quality ?? 0) - (a.quality ?? 0);
    if (quality) return quality;
    return referenceKey(a).localeCompare(referenceKey(b));
  });
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) throw new Error("Embedding vectors must have the same non-zero dimension");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Embedding vectors must contain only finite numbers");
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error("Embedding vectors must not be zero vectors");
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function softmax(scores: number[], temperature: number): number[] {
  if (!Number.isFinite(temperature) || temperature <= 0) throw new Error("Embedding temperature must be a positive number");
  const scaled = scores.map((score) => score / temperature);
  const max = Math.max(...scaled);
  const values = scaled.map((score) => Math.exp(score - max));
  const sum = values.reduce((total, value) => total + value, 0);
  return values.map((value) => value / sum);
}

export class ModelAutoSelector implements ModelSelectorService {
  private readonly candidateEmbeddingCache = new Map<string, number[]>();

  constructor(
    private readonly catalog: ModelCatalogService,
    private readonly systemOne?: SystemOneService,
    private readonly options: ModelAutoSelectorOptions = {},
  ) {}

  async select(input: ModelSelectionInput, signal?: AbortSignal): Promise<ModelSelection> {
    const eligible = this.catalog.filter(input.requirements);
    const candidates = eligible.map(({ provider, id }) => ({ provider, id }));
    const requested = input.requestedModel === "auto" ? undefined : input.requestedModel;
    const policy = input.explicitPolicy ?? "strict";

    if (requested) {
      const explicit = this.catalog.get(requested);
      const isEligible = explicit !== undefined && eligible.some((model) => referenceKey(model) === referenceKey(requested));
      if (isEligible && explicit.availability === "ready") return { model: requested, source: "explicit", candidates, order: [requested] };
      if (policy === "strict") throw new ModelSelectionError(`Explicit model ${referenceKey(requested)} is unavailable or does not satisfy requirements`, "model_explicit_invalid");
    }

    if (eligible.length === 0) throw new ModelSelectionError("No model satisfies the requested capabilities", "model_no_candidates");
    if (eligible.length === 1) return { model: candidates[0]!, source: "single", confidence: 1, probabilities: { [referenceKey(candidates[0]!)]: 1 }, candidates, order: candidates };

    let embeddingProbabilities: Record<string, number> | undefined;
    if (this.options.embeddingService) {
      try {
        const descriptions = eligible.map(candidateDescription);
        const cacheKeys = eligible.map((candidate, index) => `${referenceKey(candidate)}\n${descriptions[index]}`);
        const missingIndexes = cacheKeys.map((key, index) => this.candidateEmbeddingCache.has(key) ? -1 : index).filter((index) => index >= 0);
        const vectors = await this.options.embeddingService.embed([input.query, ...missingIndexes.map((index) => descriptions[index]!)], signal);
        if (vectors.length !== missingIndexes.length + 1) throw new Error("Embedding service returned a mismatched vector count");
        for (const [vectorIndex, candidateIndex] of missingIndexes.entries()) {
          const vector = vectors[vectorIndex + 1]!;
          cosineSimilarity(vectors[0]!, vector);
          this.candidateEmbeddingCache.set(cacheKeys[candidateIndex]!, vector);
        }
        const scores = eligible.map((_, index) => cosineSimilarity(vectors[0]!, this.candidateEmbeddingCache.get(cacheKeys[index]!)!));
        const probabilities = softmax(scores, this.options.embeddingTemperature ?? 0.1);
        embeddingProbabilities = Object.fromEntries(candidates.map((candidate, index) => [referenceKey(candidate), probabilities[index]!]));
        const bestIndex = probabilities.reduce((best, probability, index) => probability > probabilities[best]! ? index : best, 0);
        const confidence = probabilities[bestIndex]!;
        if (confidence >= (this.options.embeddingMinConfidence ?? 0.75)) {
          return { model: candidates[bestIndex]!, source: "embedding", confidence, probabilities: embeddingProbabilities, candidates, order: orderByProbability(candidates, embeddingProbabilities) };
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // A failed or malformed embedding result proceeds to the JEV classifier.
      }
    }

    if (this.systemOne && input.classifierModel) {
      const criteria = Object.fromEntries(eligible.map((model) => [referenceKey(model), candidateDescription(model)]));
      try {
        const response = await this.systemOne.systemOne({
          state: {
            query: input.query,
            ...(input.guidanceId === undefined ? {} : { guidanceId: input.guidanceId }),
            ...(input.guidanceDescription === undefined ? {} : { guidanceDescription: input.guidanceDescription }),
            ...(input.localityPreference === undefined ? {} : { localityPreference: input.localityPreference }),
            ...(embeddingProbabilities === undefined ? {} : { embeddingProbabilities }),
            ...input.runtime,
          },
          model: input.classifierModel,
          questions: { model: { type: "choice", instructions: "Choose the best eligible model for this task.", criteria } },
        }, signal);
        const answer = response.answers.model;
        const threshold = input.minConfidence ?? 0.5;
        if (answer.type === "choice" && criteria[answer.choice] !== undefined && answer.confidence >= threshold) {
          const chosen = eligible.find((model) => referenceKey(model) === answer.choice)!;
          const chosenRef = { provider: chosen.provider, id: chosen.id };
          const rest = candidates.filter((candidate) => referenceKey(candidate) !== referenceKey(chosenRef));
          return { model: chosenRef, source: "jev", confidence: answer.confidence, probabilities: answer.probabilities, candidates, order: [chosenRef, ...orderByProbability(rest, answer.probabilities)] };
        }
      } catch (error) {
        if (error instanceof ServiceUnavailableError) throw error;
      }
    }

    const ranked = rank(eligible, input.localityPreference).map(({ provider, id }) => ({ provider, id }));
    return { model: ranked[0]!, source: "fallback", candidates, order: ranked };
  }
}
