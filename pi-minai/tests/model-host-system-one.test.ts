import assert from "node:assert/strict";
import test from "node:test";
import { ModelHostSystemOneService } from "../src/index.js";
import type { ModelHostService, SystemOneRequest } from "../src/index.js";

const classifierModel = { provider: "local", id: "classifier" };
const request: SystemOneRequest = {
  model: "local/classifier",
  state: { query: "write a tool-using answer" },
  questions: { model: { type: "choice", instructions: "Choose a backend", criteria: { "local/small": "small local model, no tool support", "remote/strong": "strong remote model, supports tools" } } },
};

function classifierHost(output: string, capture?: (invocation: unknown) => void): ModelHostService {
  return {
    ready: async () => true,
    invoke: async (invocation) => { capture?.(invocation); return { model: invocation.model, text: output }; },
    async *stream() { yield { type: "done", result: { model: classifierModel, text: "", finishReason: "stop" } }; },
  };
}

test("model-host System One adapter returns a validated candidate choice", async () => {
  let invocation: unknown;
  const service = new ModelHostSystemOneService(classifierModel, () => classifierHost('<think>routing</think>\n{"answers":{"model":{"choice":"remote/strong","confidence":0.85}}}', (input) => { invocation = input; }));
  const result = await service.systemOne(request);
  assert.equal(result.answers.model?.type, "choice");
  if (result.answers.model?.type !== "choice") return;
  assert.equal(result.answers.model.choice, "remote/strong");
  assert.equal(result.answers.model.confidence, 0.85);
  assert.deepEqual(result.answers.model.probabilities, { "local/small": 0.15000000000000002, "remote/strong": 0.85 });
  assert.equal((invocation as { temperature: number }).temperature, 0);
  assert.match((invocation as { messages: Array<{ content: string }> }).messages[1]!.content, /remote\/strong/);
});

test("model-host System One adapter rejects choices outside the candidate set", async () => {
  const service = new ModelHostSystemOneService(classifierModel, () => classifierHost('{"answers":{"model":{"choice":"missing/model","confidence":0.9}}}'));
  await assert.rejects(() => service.systemOne(request), /unknown candidate/);
});
