import type { Question, SystemOneAnswer, SystemOneRequest, SystemOneResponse, SystemOneService } from "./contracts/system-one.js";
import { validateSystemOneRequest, validateSystemOneResponse } from "./contracts/validate.js";
import { SystemOneError } from "./errors.js";

export interface LocalSystemOneTier {
  classify(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse | undefined>;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function stateText(state: SystemOneRequest["state"]): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

function distribution(keys: string[], winner: string): Record<string, number> {
  if (keys.length === 1) return { [keys[0]!]: 1 };
  const rest = 0.2 / (keys.length - 1);
  return Object.fromEntries(keys.map((key) => [key, key === winner ? 0.8 : rest]));
}

function classifyQuestion(question: Question, state: string): SystemOneAnswer {
  if (question.type === "choice") {
    const stateTokens = tokens(state);
    const scores = Object.entries(question.criteria).map(([id, description]) => {
      const words = tokens(`${id} ${description}`);
      const overlap = [...words].filter((word) => stateTokens.has(word)).length;
      return { id, score: overlap };
    });
    const winner = scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]!.id;
    const probabilities = distribution(Object.keys(question.criteria), winner);
    return { type: "choice", choice: winner, probabilities, confidence: probabilities[winner]! };
  }

  if (question.type === "score") {
    const score = Math.min(question.levels.length - 1, Math.floor(tokens(state).size / 12));
    const keys = question.levels.map((_, index) => String(index));
    return { type: "score", score, legend: Object.fromEntries(question.levels.map((level, index) => [String(index), level])), probabilities: distribution(keys, String(score)), confidence: 0.8 };
  }

  const stateTokens = tokens(state);
  const criteria = question.criteria;
  const positive = criteria?.true ? [...tokens(criteria.true)].filter((word) => stateTokens.has(word)).length : 0;
  const negative = criteria?.false ? [...tokens(criteria.false)].filter((word) => stateTokens.has(word)).length : 0;
  return { type: "noul", noul: positive >= negative ? 0.75 : 0.25 };
}

export class DeterministicSystemOneTier implements LocalSystemOneTier {
  async classify(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const state = stateText(request.state);
    return {
      model: request.model,
      answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, classifyQuestion(question, state)])),
    };
  }
}

export class LocalSystemOneService implements SystemOneService {
  constructor(private readonly tiers: LocalSystemOneTier[] = [new DeterministicSystemOneTier()]) {
    if (tiers.length === 0) throw new SystemOneError("Local JEV requires at least one tier", "jev_backend");
  }

  async systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
    validateSystemOneRequest(request);
    for (const tier of this.tiers) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const response = await tier.classify(request, signal);
      if (response !== undefined) {
        validateSystemOneResponse(response, request);
        return response;
      }
    }
    throw new SystemOneError("No local JEV tier produced a result", "jev_backend");
  }
}

export const CascadeSystemOneService = LocalSystemOneService;
