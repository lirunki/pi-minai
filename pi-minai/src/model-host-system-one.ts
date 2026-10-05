import type { ModelReference } from "./contracts/common.js";
import type { SystemOneRequest, SystemOneResponse, SystemOneService } from "./contracts/system-one.js";
import { validateSystemOneRequest, validateSystemOneResponse } from "./contracts/validate.js";
import { SystemOneError } from "./errors.js";
import type { ModelHostService } from "./model.js";

export type ModelHostResolver = (reference: ModelReference) => ModelHostService;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutput(text: string): Record<string, unknown> {
  for (const candidate of [text, ...(text.match(/\{[\s\S]*\}/g) ?? [])]) {
    try {
      const decoded: unknown = JSON.parse(candidate.trim());
      if (isRecord(decoded)) return decoded;
    } catch { /* try the next JSON object */ }
  }
  throw new SystemOneError("LLM classifier returned invalid JSON", "jev_backend");
}

function probabilities(keys: string[], choice: string, confidence: number): Record<string, number> {
  if (keys.length === 1) return { [keys[0]!]: 1 };
  const rest = (1 - confidence) / (keys.length - 1);
  return Object.fromEntries(keys.map((key) => [key, key === choice ? confidence : rest]));
}

/** Adapts a configured model host into a JEV/System One choice classifier. */
export class ModelHostSystemOneService implements SystemOneService {
  constructor(private readonly model: ModelReference, private readonly resolveHost: ModelHostResolver, private readonly maxOutputTokens = 256) {}

  async systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
    validateSystemOneRequest(request);
    const choiceQuestions = Object.entries(request.questions);
    if (choiceQuestions.some(([, question]) => question.type !== "choice")) {
      throw new SystemOneError("The model-backed JEV adapter only supports choice questions", "jev_backend");
    }
    const prompt = [
      "Choose the best option for each classification question using the request and option descriptions.",
      "Only choose keys listed in that question's criteria. Return only JSON in this exact shape:",
      '{"answers":{"question_id":{"choice":"exact-option-key","confidence":0.0}}}',
      "Confidence must be a number from 0 to 1 representing how certain you are.",
      "",
      JSON.stringify({ state: request.state, questions: request.questions }),
    ].join("\n");
    const result = await this.resolveHost(this.model).invoke({
      model: this.model,
      messages: [{ role: "system", content: "You are a model-routing classifier. Select only from the supplied eligible candidates." }, { role: "user", content: prompt }],
      temperature: 0,
      maxOutputTokens: this.maxOutputTokens,
      thinking: "off",
    }, signal);
    const decoded = parseOutput(result.text);
    const rawAnswers = isRecord(decoded.answers) ? decoded.answers : decoded;
    const answers: Record<string, unknown> = {};
    for (const [id, question] of choiceQuestions) {
      if (question.type !== "choice") continue;
      const raw = rawAnswers[id] ?? (choiceQuestions.length === 1 ? rawAnswers : undefined);
      const choice = typeof raw === "string" ? raw : isRecord(raw) ? raw.choice : undefined;
      const confidence = isRecord(raw) ? raw.confidence : undefined;
      const keys = Object.keys(question.criteria);
      if (typeof choice !== "string" || !keys.includes(choice)) throw new SystemOneError(`LLM classifier selected an unknown candidate for question ${id}`, "jev_backend");
      if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new SystemOneError(`LLM classifier returned invalid confidence for question ${id}`, "jev_backend");
      answers[id] = { type: "choice", choice, confidence, probabilities: probabilities(keys, choice, confidence) };
    }
    const response = { model: request.model, answers };
    validateSystemOneResponse(response, request);
    return response;
  }
}
