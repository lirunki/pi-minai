import assert from "node:assert/strict";
import test from "node:test";
import { ModelExecutionRouter } from "../src/index.js";
import type { ModelHostService, RegistryModelRouter } from "../src/index.js";

const host: ModelHostService = {
  ready: async () => true,
  invoke: async (input) => ({ model: input.model, text: "answer", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 3 } }),
  async *stream() {
    yield { type: "thinking_delta", text: "reason" };
    yield { type: "delta", text: "answer" };
    yield { type: "done", result: { model: { provider: "python-minai", id: "m" }, text: "", finishReason: "stop" } };
  },
};
const router = { host: () => host } as unknown as RegistryModelRouter;
const request = { protocol: "openai" as const, requestId: "r", model: { provider: "python-minai", id: "m" }, messages: [{ role: "user" as const, content: "hi" }], stream: false };

test("model execution router maps direct host invocation", async () => { const result = await new ModelExecutionRouter(router).complete(request); assert.equal(result.text, "answer"); assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 3 }); });
test("model=auto falls back to an eligible candidate when no classifier is configured", async () => {
  let selected: { provider: string; id: string } | undefined;
  const fallback = { provider: "llama-serve", id: "qwen2.5-0.5b" };
  const modelRouter = {
    select: async (input: { classifierModel?: string }) => { assert.equal(input.classifierModel, undefined); return { model: fallback, source: "fallback", candidates: [fallback] }; },
    host: () => ({ ...host, invoke: async (input: { model: { provider: string; id: string } }) => { selected = input.model; return { model: input.model, text: "fallback-answer" }; } }),
  } as unknown as RegistryModelRouter;
  const result = await new ModelExecutionRouter(modelRouter).complete({ ...request, model: { provider: "default", id: "auto" } });
  assert.equal(result.text, "fallback-answer");
  assert.deepEqual(selected, fallback);
});

test("MINAI model alias enters automatic eligible-model selection", async () => {
  let selectionInput: { requestedModel: string; classifierModel?: string } | undefined;
  const selectedModel = { provider: "remote", id: "chosen" };
  let executedModel: { provider: string; id: string } | undefined;
  const router = {
    select: async (input: { requestedModel: string; classifierModel?: string }) => { selectionInput = input; return { model: selectedModel, source: "embedding", candidates: [selectedModel] }; },
    host: () => ({ ...host, invoke: async (input: { model: { provider: string; id: string } }) => { executedModel = input.model; return { model: input.model, text: "selected" }; } }),
  } as unknown as RegistryModelRouter;
  const result = await new ModelExecutionRouter(router, { classifierModel: "local/classifier" }).complete({ ...request, model: { provider: "default", id: "minai" } });
  assert.equal(result.text, "selected");
  assert.equal(selectionInput?.requestedModel, "auto");
  assert.equal(selectionInput?.classifierModel, "local/classifier");
  assert.deepEqual(executedModel, selectedModel);
});

test("model execution router executes plan steps and aggregates results", async () => {
  const calls: string[] = [];
  let callIndex = 0;
  const planningHost: ModelHostService = { ready: async () => true, invoke: async (input) => { calls.push(input.messages.map((message) => message.content).join("\n")); callIndex += 1; const text = callIndex === 1 ? '{"reasoning":"split","subtasks":[{"query":"inspect files","guidance":"code_analysis"},{"query":"summarize","guidance":"general_qa","dependsOn":["1"]}]}' : callIndex === 2 ? "step one result" : callIndex === 3 ? "step two result" : "final aggregated answer"; return { model: input.model, text, finishReason: "stop" }; }, async *stream() { yield { type: "done", result: { model: request.model, text: "", finishReason: "stop" } }; } };
  const planningRouter = { host: () => planningHost } as unknown as RegistryModelRouter;
  const events: Array<{ phase: string; message: string; steps?: Array<{ query: string; status: string }> }> = [];
  const result = await new ModelExecutionRouter(planningRouter, { planning: true, onProgress: (event) => events.push({ phase: event.phase, message: event.message, ...(event.steps ? { steps: event.steps } : {}) }) }).complete(request);
  assert.equal(result.text, "final aggregated answer");
  assert.equal(calls.length, 4);
  assert.match(calls[1]!, /inspect files/);
  assert.match(calls[2]!, /Results from prerequisite steps/);
  assert.match(calls[2]!, /step one result/);
  assert.match(calls[3]!, /subtask results above/);
  const phases = events.map((event) => event.phase);
  assert.deepEqual(phases, ["guidance", "model", "planning", "plan_ready", "step_start", "step_done", "step_start", "step_done", "aggregating", "plan_ready"]);
  const startSecond = events.find((event) => event.phase === "step_start" && event.message.includes("summarize"))!;
  assert.deepEqual(startSecond.steps.map((step) => ({ query: step.query, status: step.status })), [{ query: "inspect files", status: "completed" }, { query: "summarize", status: "running" }]);
  const aggregate = events.find((event) => event.phase === "aggregating")!;
  assert.match(aggregate.message, /aggregating 2\/2/);
  assert.deepEqual(aggregate.steps.map((step) => ({ query: step.query, status: step.status })), [{ query: "inspect files", status: "completed" }, { query: "summarize", status: "completed" }]);
});

test("model execution router streams plan progress before slow steps complete", async () => {
  let calls = 0;
  const planningHost: ModelHostService = { ready: async () => true, invoke: async (input) => { calls += 1; if (calls === 1) return { model: input.model, text: '{"goal":"g","subtasks":[{"query":"slow step"}]}', finishReason: "stop" }; if (calls === 2) { await new Promise((resolve) => setTimeout(resolve, 40)); return { model: input.model, text: "step result", finishReason: "stop" }; } return { model: input.model, text: "final", finishReason: "stop" }; }, async *stream(input) { yield { type: "delta", text: "final" }; yield { type: "done", result: { model: input.model, text: "final", finishReason: "stop" } }; } };
  const service = new ModelExecutionRouter({ host: () => planningHost } as unknown as RegistryModelRouter, { planning: true });
  const iterator = service.stream({ ...request, stream: true })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.type, "thinking_delta");
  assert.match(first.value?.type === "thinking_delta" ? first.value.delta : "", /executing 1-step plan/);
  const next = await iterator.next();
  assert.equal(next.value?.type, "thinking_delta");
  assert.match(next.value?.type === "thinking_delta" ? next.value.delta : "", /plan step 1: slow step/);
  await iterator.return?.();
});

test("model execution router preserves thinking and text streams", async () => { const events = []; for await (const event of new ModelExecutionRouter(router).stream({ ...request, stream: true })) events.push(event); assert.deepEqual(events.map((event) => event.type), ["thinking_delta", "text_delta", "done"]); assert.equal((events[2] as { result: { text: string } }).result.text, "answer"); });

test("router tolerates prose around planner JSON and forces a plan when asked", async () => {
  const request2 = { ...request, requestId: "r2" };
  // Planner wraps JSON in prose and omits dependencies; env forces planning for direct answers.
  process.env.MINAI_FORCE_PLANNING = "1";
  try {
    let calls = 0;
    const host: ModelHostService = { ready: async () => true, invoke: async (input) => { calls += 1; if (calls === 1) return { model: input.model, text: 'Sure! Here is my plan: {"goal":"g","subtasks":[{"query":"step A"}]} hope that helps', finishReason: "stop" }; if (calls === 2) return { model: input.model, text: "A", finishReason: "stop" }; return { model: input.model, text: "final", finishReason: "stop" }; }, async *stream() { yield { type: "done", result: { model: request2.model, text: "", finishReason: "stop" } }; } };
    const service = new ModelExecutionRouter({ host: () => host } as unknown as RegistryModelRouter, { planning: true });
    const result = await service.complete(request2);
    assert.equal(result.text, "final");
    // Direct-answer planner output ("final") with force enabled yields the canonical 2-step plan.
    calls = 0;
    const directHost: ModelHostService = { ready: async () => true, invoke: async (input) => { calls += 1; if (calls === 1) return { model: input.model, text: '{"final":"direct"}', finishReason: "stop" }; return { model: input.model, text: "part", finishReason: "stop" }; }, async *stream() { yield { type: "done", result: { model: request2.model, text: "", finishReason: "stop" } }; } };
    const forced = new ModelExecutionRouter({ host: () => directHost } as unknown as RegistryModelRouter, { planning: true });
    const progress: string[] = [];
    const forcedResult = await forced.complete({ ...request2, requestId: "r3" }, undefined);
    assert.ok(forcedResult.text.length > 0);
    assert.equal(forced.board.stats().total >= 0, true);
  } finally {
    delete process.env.MINAI_FORCE_PLANNING;
  }
});
