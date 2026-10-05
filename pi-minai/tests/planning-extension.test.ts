import assert from "node:assert/strict";
import test from "node:test";
import { createPlanningTools, planningBoard, planTreeLines } from "../extensions/planning.js";

const fakeCtx = { ui: { setWidget: (_id: string, _widget?: unknown) => {}, notify: () => {} } } as never;

function resetBoard(): void { planningBoard().clear(); }

test("manage_plan tool installs a validated plan on the shared board", async () => {
  resetBoard();
  const [managePlan] = createPlanningTools();
  const result = await managePlan.execute("t", { operation: "write", goal: "compare stores", steps: [{ query: "analyze postgres" }, { query: "recommend", dependsOn: ["1"] }] }, undefined, undefined, fakeCtx);
  assert.ok(!result.isError);
  const plan = planningBoard().read()!;
  assert.equal(plan.goal, "compare stores");
  assert.deepEqual(plan.steps.map((step) => step.id), ["1", "2"]);
  assert.deepEqual(plan.steps[1]!.dependsOn, ["1"]);
});

test("manage_plan read returns step views; write validation errors are reported", async () => {
  resetBoard();
  const [managePlan] = createPlanningTools();
  await managePlan.execute("t", { operation: "write", goal: "g", steps: [{ query: "a" }] }, undefined, undefined, fakeCtx);
  const read = await managePlan.execute("t", { operation: "read" }, undefined, undefined, fakeCtx);
  assert.match(String(read.content[0]!.text), /"query": "a"/);
  const bad = await managePlan.execute("t", { operation: "write", goal: "g", steps: [{ query: "a", dependsOn: ["7"] }] }, undefined, undefined, fakeCtx);
  assert.ok(bad.isError);
  assert.match(String(bad.content[0]!.text), /unknown step/);
});

test("newplan discards the previous plan", async () => {
  resetBoard();
  const [, newPlan] = createPlanningTools();
  await newPlan.execute("t", { goal: "first", steps: [{ query: "old" }] }, undefined, undefined, fakeCtx);
  await newPlan.execute("t", { goal: "second", steps: [{ query: "new one" }, { query: "new two" }] }, undefined, undefined, fakeCtx);
  const plan = planningBoard().read()!;
  assert.equal(plan.goal, "second");
  assert.equal(plan.steps.length, 2);
  assert.ok(plan.steps.every((step) => step.status === "pending"));
});

test("plan tree renders icons, deps and preference hints", () => {
  const lines = planTreeLines({ goal: "compare stores", steps: [{ id: "1", query: "analyze postgres", status: "completed", dependsOn: [] }, { id: "2", query: "recommend", status: "running", dependsOn: ["1"], guidance: "code_review", model: "llama-serve/qwen2.5-0.5b" }], aggregation: { status: "pending" } }, { fg: (_role: string, text: string) => text, strikethrough: (text: string) => `~${text}~` } as never);
  assert.match(lines[0]!, /MINAI Plan .* 1\/2 done · compare stores/);
  assert.match(lines[1]!, /✓ 1\. ~analyze postgres~/);
  assert.match(lines[2]!, /◉ 2\. recommend  ← 1 · guide=code_review · model=llama-serve\/qwen2\.5-0\.5b/);
  assert.match(lines[3]!, /aggregation/);
});
