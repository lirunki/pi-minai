import assert from "node:assert/strict";
import test from "node:test";
import { CascadeSystemOneService, DeterministicSystemOneTier, LocalSystemOneService, createSystemOneService } from "../src/index.js";
import type { SystemOneRequest, SystemOneResponse } from "../src/index.js";

const request: SystemOneRequest = {
  state: "The implementation has many independent modules and should be split into tasks.",
  model: "local-jev",
  questions: {
    route: { type: "choice", instructions: "Select a route", criteria: { simple: "A simple answer", decomposition: "Decomposition for many modules" } },
    size: { type: "score", instructions: "Estimate size", levels: ["small", "large"] },
    needsPlan: { type: "noul", instructions: "Does this need a plan?", criteria: { true: "independent modules", false: "simple answer" } },
  },
};

test("deterministic local JEV emits valid Choice, Score, and Noul answers", async () => {
  const response = await new LocalSystemOneService().systemOne(request);
  assert.equal(response.answers.route.type, "choice");
  assert.equal(response.answers.size.type, "score");
  assert.equal(response.answers.needsPlan.type, "noul");
  if (response.answers.route.type === "choice") assert.equal(response.answers.route.choice, "decomposition");
});

test("local cascade tries tiers in order and accepts the first result", async () => {
  const calls: string[] = [];
  const response: SystemOneResponse = { model: request.model, answers: {
    route: { type: "choice", choice: "simple", probabilities: { simple: 1, decomposition: 0 }, confidence: 1 },
    size: { type: "score", score: 0, legend: {}, probabilities: { "0": 1, "1": 0 }, confidence: 1 },
    needsPlan: { type: "noul", noul: 0.1 },
  } };
  const service = new CascadeSystemOneService([
    { classify: async () => { calls.push("first"); return undefined; } },
    { classify: async () => { calls.push("second"); return response; } },
    { classify: async () => { calls.push("third"); return response; } },
  ]);
  await service.systemOne(request);
  assert.deepEqual(calls, ["first", "second"]);
});

test("auto configuration is offline and honors abort before classification", async () => {
  const service = createSystemOneService({ backend: "auto", remote: { baseUrl: "https://unused.test" } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => service.systemOne(request, controller.signal), /Abort/);
});

test("custom local tiers can be injected without importing model code", async () => {
  const tier = new DeterministicSystemOneTier();
  const service = createSystemOneService({ backend: "local", remote: { baseUrl: "https://unused.test" } }, { localTiers: [tier] });
  const response = await service.systemOne(request);
  assert.equal(response.model, "local-jev");
});
