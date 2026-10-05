import assert from "node:assert/strict";
import test from "node:test";
import { FakeSystemOneService, GuidanceSelector, StaticGuidanceCatalog } from "../src/index.js";

const catalog = new StaticGuidanceCatalog([
  { id: "general_qa", description: "Answer general questions.", instances: [{ instructions: "Answer clearly." }] },
  { id: "code_review", description: "Review code and identify issues.", tags: ["code"], instances: [
    { instructions: "Review generally.", rank: 2 },
    { modelClassRegex: "qwen", instructions: "Review with Qwen-specific format.", rank: 1 },
  ] },
]);

test("catalog resolves generic and model-specific guidance instances", () => {
  assert.equal(catalog.resolve("code_review", "qwen2.5").instructions, "Review with Qwen-specific format.");
  assert.equal(catalog.resolve("code_review", "other-model").instructions, "Review generally.");
});

test("explicit guidance bypasses JEV", async () => {
  const fake = new FakeSystemOneService(async () => { throw new Error("JEV should not be called"); });
  const selector = new GuidanceSelector(catalog, fake);
  const result = await selector.select({ query: "review this", model: "qwen", explicitGuidance: "code_review" });
  assert.deepEqual(result, { id: "code_review", source: "explicit" });
  assert.equal(fake.requests.length, 0);
});

test("selector sends one generic Choice question and interprets the answer", async () => {
  const fake = new FakeSystemOneService((request) => {
    assert.equal(request.questions.guidance.type, "choice");
    assert.deepEqual(Object.keys(request.questions.guidance.criteria), ["general_qa", "code_review"]);
    assert.equal((request.state as Record<string, unknown>).query, "review this");
    return {
      model: request.model,
      answers: { guidance: { type: "choice", choice: "code_review", probabilities: { general_qa: 0.1, code_review: 0.9 }, confidence: 0.9 } },
    };
  });
  const selector = new GuidanceSelector(catalog, fake);
  const result = await selector.select({ query: "review this", model: "jev-local", hasCode: true });
  assert.equal(result.id, "code_review");
  assert.equal(result.source, "jev");
});

test("selector falls back when JEV confidence is low or unavailable", async () => {
  const lowConfidence = new FakeSystemOneService((request) => ({
    model: request.model,
    answers: { guidance: { type: "choice", choice: "code_review", probabilities: { general_qa: 0.4, code_review: 0.6 }, confidence: 0.2 } },
  }));
  const selector = new GuidanceSelector(catalog, lowConfidence, { minConfidence: 0.8 });
  assert.deepEqual(await selector.select({ query: "x", model: "m" }), { id: "general_qa", source: "fallback" });

  const withoutJev = new GuidanceSelector(catalog);
  assert.deepEqual(await withoutJev.select({ query: "x", model: "m" }), { id: "general_qa", source: "fallback" });
});
