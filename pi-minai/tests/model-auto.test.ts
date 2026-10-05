import assert from "node:assert/strict";
import test from "node:test";
import { FakeSystemOneService, ModelAutoSelector, ModelSelectionError, StaticModelCatalog } from "../src/index.js";
import type { AvailableModel } from "../src/index.js";

const models: AvailableModel[] = [
  { provider: "local", id: "small", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: false, vision: false, reasoning: false, streaming: true }, locality: "local", availability: "ready", quality: 0.6 },
  { provider: "remote", id: "strong", contextWindow: 16384, maxOutputTokens: 2048, capabilities: { tools: true, vision: true, reasoning: true, streaming: true }, locality: "remote", availability: "ready", quality: 0.95 },
  { provider: "local", id: "cold", contextWindow: 8192, maxOutputTokens: 1024, capabilities: { tools: true, vision: false, reasoning: true, streaming: true }, locality: "local", availability: "cold", quality: 0.99 },
];
const catalog = new StaticModelCatalog(models);
const base = { query: "analyze this code", classifierModel: "jev-local" } as const;

test("auto filters hard requirements before the single-candidate shortcut", async () => {
  const fake = new FakeSystemOneService((request) => {
    const question = request.questions.model;
    assert.deepEqual(Object.keys(question.criteria), ["remote/strong"]);
    return { model: request.model, answers: { model: { type: "choice", choice: "remote/strong", probabilities: { "remote/strong": 1 }, confidence: 1 } } };
  });
  const selector = new ModelAutoSelector(catalog, fake);
  const result = await selector.select({ ...base, requestedModel: "auto", requirements: { tools: true, vision: true } });
  assert.deepEqual(result.model, { provider: "remote", id: "strong" });
  assert.equal(result.source, "single");
  assert.equal(fake.requests.length, 0);
});

test("auto short-circuits one eligible candidate without embeddings or JEV", async () => {
  const onlyCandidate = new StaticModelCatalog([models[0]!]);
  let embeddingCalls = 0;
  const embeddings = { embed: async () => { embeddingCalls++; throw new Error("should not embed"); } };
  const jev = new FakeSystemOneService(async () => { throw new Error("should not call JEV"); });
  const result = await new ModelAutoSelector(onlyCandidate, jev, { embeddingService: embeddings }).select({ ...base, requestedModel: "auto" });
  assert.deepEqual(result.model, { provider: "local", id: "small" });
  assert.equal(result.source, "single");
  assert.equal(embeddingCalls, 0);
  assert.equal(jev.requests.length, 0);
});

test("auto uses a confident softmax over embedding cosine similarities", async () => {
  const twoModels = new StaticModelCatalog(models.slice(0, 2));
  const jev = new FakeSystemOneService(async () => { throw new Error("confident embeddings should skip JEV"); });
  const embeddings = { embed: async () => [[1, 0], [0, 1], [1, 0]] };
  const result = await new ModelAutoSelector(twoModels, jev, { embeddingService: embeddings, embeddingTemperature: 0.1, embeddingMinConfidence: 0.75 }).select({ ...base, requestedModel: "auto" });
  assert.deepEqual(result.model, { provider: "remote", id: "strong" });
  assert.equal(result.source, "embedding");
  assert.ok((result.confidence ?? 0) > 0.99);
  assert.equal(jev.requests.length, 0);
});

test("candidate description embeddings are cached between automatic selections", async () => {
  const twoModels = new StaticModelCatalog(models.slice(0, 2));
  const batches: string[][] = [];
  const embeddings = { embed: async (texts: string[]) => { batches.push(texts); return texts.length === 3 ? [[1, 0], [0, 1], [1, 0]] : [[1, 0]]; } };
  const selector = new ModelAutoSelector(twoModels, undefined, { embeddingService: embeddings, embeddingMinConfidence: 0.75 });
  await selector.select({ ...base, requestedModel: "auto" });
  await selector.select({ ...base, query: "another query", requestedModel: "auto" });
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 3);
  assert.deepEqual(batches[1], ["another query"]);
});

test("auto uses the JEV classifier directly when embeddings are not configured", async () => {
  const twoModels = new StaticModelCatalog(models.slice(0, 2));
  const jev = new FakeSystemOneService((request) => ({ model: request.model, answers: { model: { type: "choice", choice: "local/small", probabilities: { "local/small": 0.8, "remote/strong": 0.2 }, confidence: 0.8 } } }));
  const result = await new ModelAutoSelector(twoModels, jev).select({ ...base, requestedModel: "auto" });
  assert.deepEqual(result.model, { provider: "local", id: "small" });
  assert.equal(result.source, "jev");
  assert.equal(jev.requests.length, 1);
});

test("uncertain embeddings fall through to the JEV classifier", async () => {
  const twoModels = new StaticModelCatalog(models.slice(0, 2));
  const jev = new FakeSystemOneService((request) => {
    assert.deepEqual((request.state as Record<string, unknown>).embeddingProbabilities, { "local/small": 0.5, "remote/strong": 0.5 });
    return { model: request.model, answers: { model: { type: "choice", choice: "remote/strong", probabilities: { "local/small": 0.1, "remote/strong": 0.9 }, confidence: 0.9 } } };
  });
  const embeddings = { embed: async () => [[1, 0], [1, 0], [1, 0]] };
  const result = await new ModelAutoSelector(twoModels, jev, { embeddingService: embeddings, embeddingMinConfidence: 0.75 }).select({ ...base, requestedModel: "auto" });
  assert.deepEqual(result.model, { provider: "remote", id: "strong" });
  assert.equal(result.source, "jev");
  assert.equal(jev.requests.length, 1);
});

test("explicit ready model is honored without calling JEV", async () => {
  const fake = new FakeSystemOneService(async () => { throw new Error("not called"); });
  const result = await new ModelAutoSelector(catalog, fake).select({ ...base, requestedModel: { provider: "local", id: "small" } });
  assert.equal(result.source, "explicit");
  assert.equal(fake.requests.length, 0);
});

test("strict explicit policy rejects incompatible model while route policy falls back", async () => {
  const selector = new ModelAutoSelector(catalog);
  await assert.rejects(() => selector.select({ ...base, requestedModel: { provider: "local", id: "small" }, requirements: { tools: true } }), (error: unknown) => error instanceof ModelSelectionError && error.code === "model_explicit_invalid");
  const result = await selector.select({ ...base, requestedModel: { provider: "local", id: "small" }, explicitPolicy: "route", requirements: { tools: true } });
  assert.deepEqual(result.model, { provider: "remote", id: "strong" });
  assert.equal(result.source, "fallback");
});

test("low-confidence or missing JEV uses deterministic ranking", async () => {
  const low = new FakeSystemOneService((request) => ({ model: request.model, answers: { model: { type: "choice", choice: "local/small", probabilities: { "local/small": 0.6, "remote/strong": 0.4 }, confidence: 0.2 } } }));
  const result = await new ModelAutoSelector(catalog, low).select({ ...base, requestedModel: "auto", minConfidence: 0.8 });
  assert.deepEqual(result.model, { provider: "remote", id: "strong" });
  assert.equal(result.source, "fallback");
});

test("empty eligible set has a stable error", async () => {
  await assert.rejects(() => new ModelAutoSelector(catalog).select({ ...base, requestedModel: "auto", requirements: { vision: true, locality: "local" } }), (error: unknown) => error instanceof ModelSelectionError && error.code === "model_no_candidates");
});
