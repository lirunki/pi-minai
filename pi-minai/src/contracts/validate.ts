import { ContractValidationError } from "../errors.js";
import type {
  ChoiceAnswer,
  NoulAnswer,
  Question,
  ScoreAnswer,
  SystemOneAnswer,
  SystemOneRequest,
  SystemOneResponse,
} from "./system-one.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requireText(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractValidationError(`${path} must be a non-empty string`);
  }
}

function requireProbability(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ContractValidationError(`${path} must be a finite number in [0, 1]`);
  }
}

function validateQuestion(question: unknown, path: string): asserts question is Question {
  if (!isRecord(question)) throw new ContractValidationError(`${path} must be an object`);
  requireText(question.type, `${path}.type`);
  requireText(question.instructions, `${path}.instructions`);

  if (question.type === "choice") {
    if (!isRecord(question.criteria) || Object.keys(question.criteria).length === 0) {
      throw new ContractValidationError(`${path}.criteria must be a non-empty object`);
    }
    for (const [name, description] of Object.entries(question.criteria)) {
      requireText(name, `${path}.criteria key`);
      requireText(description, `${path}.criteria.${name}`);
    }
    return;
  }

  if (question.type === "score") {
    if (!Array.isArray(question.levels) || question.levels.length < 2) {
      throw new ContractValidationError(`${path}.levels must contain at least two levels`);
    }
    question.levels.forEach((level, index) => requireText(level, `${path}.levels[${index}]`));
    return;
  }

  if (question.type === "noul") {
    if (question.criteria !== undefined) {
      if (!isRecord(question.criteria)) throw new ContractValidationError(`${path}.criteria must be an object`);
      requireText(question.criteria.true, `${path}.criteria.true`);
      requireText(question.criteria.false, `${path}.criteria.false`);
    }
    return;
  }

  throw new ContractValidationError(`${path}.type is not a supported System One question type`);
}

export function validateSystemOneRequest(value: unknown): asserts value is SystemOneRequest {
  if (!isRecord(value)) throw new ContractValidationError("System One request must be an object");
  if (typeof value.state !== "string" && !isRecord(value.state)) {
    throw new ContractValidationError("request.state must be a string or object");
  }
  requireText(value.model, "request.model");
  if (!isRecord(value.questions) || Object.keys(value.questions).length === 0) {
    throw new ContractValidationError("request.questions must be a non-empty object");
  }
  for (const [id, question] of Object.entries(value.questions)) validateQuestion(question, `request.questions.${id}`);
}

function validateProbabilities(value: unknown, allowed: Set<string>, path: string): Record<string, number> {
  if (!isRecord(value)) throw new ContractValidationError(`${path} must be an object`);
  const result: Record<string, number> = {};
  let total = 0;
  for (const [key, probability] of Object.entries(value)) {
    if (!allowed.has(key)) throw new ContractValidationError(`${path}.${key} is not a declared option`);
    requireProbability(probability, `${path}.${key}`);
    result[key] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 0.02) throw new ContractValidationError(`${path} must sum to approximately 1`);
  return result;
}

function validateAnswer(answer: unknown, question: Question, path: string): SystemOneAnswer {
  if (!isRecord(answer)) throw new ContractValidationError(`${path} must be an object`);
  requireText(answer.type, `${path}.type`);

  if (question.type === "choice" && answer.type === "choice") {
    const names = new Set(Object.keys(question.criteria));
    requireText(answer.choice, `${path}.choice`);
    if (!names.has(answer.choice)) throw new ContractValidationError(`${path}.choice is not declared`);
    const probabilities = validateProbabilities(answer.probabilities, names, `${path}.probabilities`);
    requireProbability(answer.confidence, `${path}.confidence`);
    return { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence } satisfies ChoiceAnswer;
  }

  if (question.type === "score" && answer.type === "score") {
    if (typeof answer.score !== "number" || answer.score < 0 || answer.score > question.levels.length - 1) {
      throw new ContractValidationError(`${path}.score is outside the declared levels`);
    }
    const legend: Record<string, string> = {};
    question.levels.forEach((level, index) => { legend[String(index)] = level; });
    const probabilities = validateProbabilities(answer.probabilities, new Set(Object.keys(legend)), `${path}.probabilities`);
    requireProbability(answer.confidence, `${path}.confidence`);
    return { type: "score", score: answer.score, legend, probabilities, confidence: answer.confidence } satisfies ScoreAnswer;
  }

  if (question.type === "noul" && answer.type === "noul") {
    requireProbability(answer.noul, `${path}.noul`);
    return { type: "noul", noul: answer.noul } satisfies NoulAnswer;
  }

  throw new ContractValidationError(`${path}.type does not match the question type`);
}

export function validateSystemOneResponse(value: unknown, request: SystemOneRequest): asserts value is SystemOneResponse {
  if (!isRecord(value)) throw new ContractValidationError("System One response must be an object");
  requireText(value.model, "response.model");
  if (!isRecord(value.answers)) throw new ContractValidationError("response.answers must be an object");

  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (!(id in value.answers)) throw new ContractValidationError(`response.answers.${id} is missing`);
    answers[id] = validateAnswer(value.answers[id], question, `response.answers.${id}`);
  }
  Object.assign(value, { answers });
}
