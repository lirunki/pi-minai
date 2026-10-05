import assert from "node:assert/strict";
import test from "node:test";
import { GraphValidationError, PlanStore, SchedulerError, TaskScheduler, validateTaskGraph } from "../src/index.js";
import type { TaskGraph, TaskNode } from "../src/index.js";

const task = (id: string, dependencyIds: string[] = []): TaskNode => ({ id, planVersion: 1, query: id, dependencyIds, artifactIds: [], status: "pending" });

test("validates dependencies and rejects cycles", () => {
  validateTaskGraph({ planVersion: 1, nodes: [task("a"), task("b", ["a"])] });
  assert.throws(() => validateTaskGraph({ planVersion: 1, nodes: [task("a", ["b"]), task("b", ["a"])] }), GraphValidationError);
  assert.throws(() => validateTaskGraph({ planVersion: 1, nodes: [task("a", ["missing"])] }), /missing task/);
});

test("runs independent tasks concurrently and dependencies afterward", async () => {
  const graph: TaskGraph = { planVersion: 1, nodes: [task("a"), task("b"), task("c", ["a", "b"]) ] };
  let active = 0;
  let maximum = 0;
  const started: string[] = [];
  const result = await new TaskScheduler(2).run(graph, async ({ node }) => {
    started.push(node.id); active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, node.id === "a" ? 10 : 2));
    active--; return { text: `result:${node.id}` };
  });
  assert.equal(maximum, 2);
  assert.deepEqual(started.slice(0, 2).sort(), ["a", "b"]);
  assert.equal(started[2], "c");
  assert.equal(result.graph.nodes.find((node) => node.id === "c")?.status, "completed");
});

test("failed tasks cancel dependent tasks without false completion", async () => {
  const graph: TaskGraph = { planVersion: 1, nodes: [task("bad"), task("dependent", ["bad"])] };
  const result = await new TaskScheduler().run(graph, async ({ node }) => {
    if (node.id === "bad") throw new Error("boom");
    return { text: "wrong" };
  });
  assert.equal(result.graph.nodes.find((node) => node.id === "bad")?.status, "failed");
  assert.equal(result.graph.nodes.find((node) => node.id === "dependent")?.status, "cancelled");
  assert.equal(result.results.dependent, undefined);
});

test("cancellation aborts active work and cancels pending tasks", async () => {
  const controller = new AbortController();
  let aborted = false;
  const graph: TaskGraph = { planVersion: 1, nodes: [task("a"), task("b")] };
  const run = new TaskScheduler(1).run(graph, async ({ signal }) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    throw new Error("cancelled");
  }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(run, (error: unknown) => error instanceof SchedulerError && error.code === "scheduler_cancelled");
  assert.equal(aborted, true);
});

test("NEWPLAN increments version, obsoletes work, and adds replacement tasks", () => {
  const store = new PlanStore({ planVersion: 1, nodes: [
    { ...task("old"), status: "completed", result: "preserve" },
    task("pending"),
  ] });
  const graph = store.applyNewPlan({ reason: "new fact", discoveredFacts: ["fact"], unresolvedQuestions: [], obsoleteTaskIds: ["pending"], preservedArtifactIds: [], proposedTasks: [task("replacement")] });
  assert.equal(graph.planVersion, 2);
  assert.equal(graph.nodes.find((node) => node.id === "old")?.result, "preserve");
  assert.equal(graph.nodes.find((node) => node.id === "pending")?.status, "obsolete");
  assert.equal(graph.nodes.find((node) => node.id === "replacement")?.status, "pending");
});
