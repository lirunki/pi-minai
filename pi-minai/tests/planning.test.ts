import assert from "node:assert/strict";
import test from "node:test";
import { PlanBoard, normalizePlanSteps, REASONING_LEVELS } from "../src/planning.js";
import type { PlanStep } from "../src/planning.js";

function step(partial: Partial<PlanStep>): PlanStep {
  return { id: partial.id ?? "", query: partial.query ?? "do work", ...(partial.guidance ? { guidance: partial.guidance } : {}), ...(partial.model ? { model: partial.model } : {}), ...(partial.reasoning ? { reasoning: partial.reasoning } : {}), dependsOn: partial.dependsOn ?? [], status: partial.status ?? "pending", ...(partial.result ? { result: partial.result } : {}) };
}

test("plan board normalizes steps and auto-assigns ids", () => {
  const board = new PlanBoard();
  const validation = board.write("compare stores", [
    { id: "", query: "analyze postgres", dependsOn: [], status: "pending" },
    { id: "", query: "analyze mongo", dependsOn: [], status: "pending" },
    { id: "", query: "recommend", dependsOn: ["1", "2"], status: "pending" },
  ] as PlanStep[]);
  assert.ok(validation.valid, validation.errors.join("; "));
  const plan = board.read()!;
  assert.deepEqual(plan.steps.map((s) => s.id), ["1", "2", "3"]);
  assert.equal(plan.goal, "compare stores");
  assert.equal(plan.aggregation?.status, "pending");
});

test("plan board rejects unknown deps and cycles", () => {
  const board = new PlanBoard();
  assert.equal(board.write("goal", [step({ dependsOn: ["9"] })]).valid, false);
  assert.equal(board.write("goal", [step({ id: "1", dependsOn: ["2"] }), step({ id: "2", dependsOn: ["1"] })]).valid, false);
  assert.equal(board.write("goal", [step({ id: "1", dependsOn: [] }), step({ id: "2", dependsOn: ["1"] })]).valid, true);
});

test("plan board schedules ready steps in dependency order", () => {
  const board = new PlanBoard();
  board.write("goal", [step({ id: "1" }), step({ id: "2" }), step({ id: "3", dependsOn: ["1", "2"] })] as PlanStep[]);
  assert.deepEqual(board.readySteps().map((s) => s.id), ["1", "2"]);
  board.markRunning("1");
  board.markCompleted("1", "result one");
  assert.deepEqual(board.readySteps().map((s) => s.id), ["2"]);
  board.markCompleted("2", "result two");
  assert.deepEqual(board.readySteps().map((s) => s.id), ["3"]);
  board.markRunning("3");
  assert.deepEqual(board.readySteps(), []);
  const plan = board.read()!;
  assert.equal(plan.steps[0]!.result, "result one");
  assert.equal(plan.steps[0]!.status, "completed");
  assert.equal(plan.steps[2]!.status, "running");
});

test("plan board tracks aggregation and auto-clears when fully complete", async () => {
  const board = new PlanBoard();
  board.write("goal", [step({ id: "1" })] as PlanStep[]);
  board.markRunning("1");
  board.markFailed("1", "boom");
  const stats = board.stats();
  assert.equal(stats.failed, 1);
  board.markCompleted("1", "recovered");
  board.startAggregation();
  assert.equal(board.read()!.aggregation?.status, "running");
  board.completeAggregation("final");
  assert.equal(board.read()!.aggregation?.status, "completed");
  assert.equal(board.read()!.aggregation?.result, "final");
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(board.read(), undefined);
});

test("normalizePlanSteps keeps guidance, model, reasoning preferences", () => {
  const steps = normalizePlanSteps([{ query: "step", guidance: "code_review", model: "llama-serve/qwen2.5-0.5b", reasoning: "low" }, { query: "bad reasoning", reasoning: "ludicrous" }]);
  assert.equal(steps[0]!.guidance, "code_review");
  assert.equal(steps[0]!.model, "llama-serve/qwen2.5-0.5b");
  assert.equal(steps[0]!.reasoning, "low");
  assert.equal(steps[1]!.reasoning, undefined);
  assert.equal(steps[1]!.id, "2");
});
