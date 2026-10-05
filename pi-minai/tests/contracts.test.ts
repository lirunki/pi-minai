import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError,
  ServiceRegistry,
  validateSystemOneRequest,
  validateSystemOneResponse,
} from "../src/index.js";

test("validates a batched System One request and response", () => {
  const request = {
    state: "Review this code",
    model: "jev-local",
    questions: {
      guidance: {
        type: "choice" as const,
        instructions: "Which role applies?",
        criteria: {
          code_review: "Critique existing code.",
          code_analysis: "Analyze existing code and architecture.",
        },
      },
      complexity: {
        type: "score" as const,
        instructions: "How complex is the task?",
        levels: ["Simple", "Moderate", "Complex"],
      },
      decompose: {
        type: "noul" as const,
        instructions: "Does this require decomposition?",
      },
    },
  };

  validateSystemOneRequest(request);
  const response = {
    model: "jev-local",
    answers: {
      guidance: {
        type: "choice" as const,
        choice: "code_analysis",
        probabilities: { code_review: 0.2, code_analysis: 0.8 },
        confidence: 0.8,
      },
      complexity: {
        type: "score" as const,
        score: 1.6,
        legend: {},
        probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
        confidence: 0.6,
      },
      decompose: { type: "noul" as const, noul: 0.9 },
    },
  };

  validateSystemOneResponse(response, request);
  assert.deepEqual(response.answers.complexity.legend, {
    "0": "Simple",
    "1": "Moderate",
    "2": "Complex",
  });
});

test("rejects an undeclared choice and malformed probabilities", () => {
  const request = {
    state: "x",
    model: "jev-local",
    questions: {
      q: { type: "choice" as const, instructions: "Choose", criteria: { a: "A", b: "B" } },
    },
  };
  validateSystemOneRequest(request);

  assert.throws(
    () => validateSystemOneResponse({ model: "jev-local", answers: { q: { type: "choice", choice: "c", probabilities: { a: 1 }, confidence: 1 } } }, request),
    ContractValidationError,
  );
});

test("registry supports optional services and required lookup", () => {
  const registry = new ServiceRegistry();
  const service = { systemOne: async () => ({ model: "fake", answers: {} }) };
  registry.register("candidate:system-one", service);
  assert.equal(registry.has("candidate:system-one"), true);
  assert.equal(registry.require("candidate:system-one"), service);
  assert.throws(() => registry.require("hoster:model"), /Required service is unavailable/);
});
