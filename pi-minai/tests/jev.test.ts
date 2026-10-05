import assert from "node:assert/strict";
import test from "node:test";
import { FakeSystemOneService, RemoteSystemOneService, SystemOneError } from "../src/index.js";
import type { SystemOneRequest } from "../src/index.js";

const request: SystemOneRequest = {
  state: "Review this code",
  model: "jev-latest",
  questions: {
    guidance: {
      type: "choice",
      instructions: "Which role applies?",
      criteria: { review: "Critique code", analysis: "Analyze code" },
    },
    complexity: {
      type: "score",
      instructions: "How complex?",
      levels: ["simple", "complex"],
    },
    decompose: {
      type: "noul",
      instructions: "Does this require decomposition?",
    },
  },
};

test("fake System One service validates and records batched requests", async () => {
  const fake = new FakeSystemOneService((input) => ({
    model: input.model,
    answers: {
      guidance: { type: "choice", choice: "analysis", probabilities: { review: 0.1, analysis: 0.9 }, confidence: 0.9 },
      complexity: { type: "score", score: 0.7, legend: {}, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.7 },
      decompose: { type: "noul", noul: 0.8 },
    },
  }));

  const response = await fake.systemOne(request);
  assert.equal(response.answers.guidance.type, "choice");
  assert.equal(fake.requests.length, 1);
});

test("remote backend forwards the literal request and bearer auth", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const remote = new RemoteSystemOneService(
    { baseUrl: "https://api.typesafe.ai", apiKey: "secret", timeoutMs: 1000 },
    async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({
        model: "jev-latest",
        answers: {
          guidance: { type: "choice", choice: "analysis", probabilities: { review: 0.1, analysis: 0.9 }, confidence: 0.9 },
          complexity: { type: "score", score: 0.7, legend: {}, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.7 },
          decompose: { type: "noul", noul: 0.8 },
        },
      }), { status: 200 });
    },
  );

  const response = await remote.systemOne(request);
  assert.equal(captured?.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(captured?.init?.method, "POST");
  assert.equal((captured?.init?.headers as Record<string, string>).authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), request);
  assert.equal(response.answers.decompose.type, "noul");
});

test("remote backend classifies HTTP errors", async () => {
  const remote = new RemoteSystemOneService({ baseUrl: "https://example.test" }, async () => new Response("bad", { status: 503 }));
  await assert.rejects(() => remote.systemOne(request), (error: unknown) => error instanceof SystemOneError && error.code === "jev_http");
});

test("remote backend classifies timeout/abort", async () => {
  const remote = new RemoteSystemOneService({ baseUrl: "https://example.test", timeoutMs: 1 }, async (_url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (init?.signal?.aborted) throw new Error("aborted");
    return new Response("never");
  });
  await assert.rejects(() => remote.systemOne(request), (error: unknown) => error instanceof SystemOneError && error.code === "jev_timeout");
});
