import assert from "node:assert/strict";
import test from "node:test";
import { HttpRunRegistry } from "../src/index.js";

test("HTTP run registry tracks and authorizes cancellation", () => {
  const registry = new HttpRunRegistry();
  const run = registry.register({ id: "r", owner: "client-a" });
  assert.equal(registry.size, 1);
  assert.equal(registry.abort("r", "client-b"), false);
  assert.equal(run.controller.signal.aborted, false);
  assert.equal(registry.abort("r", "client-a"), true);
  assert.equal(run.controller.signal.aborted, true);
});

test("HTTP run registry stores rich execution state", () => {
  const registry = new HttpRunRegistry(); registry.register({ id: "state" }); registry.update("state", { model: "llama/qwen", guidance: "coding", thinking: "low", usage: { input: 2 }, currentTask: "streaming", continuation: "tool-1", output: "hello", outputMode: "text" }); assert.deepEqual(registry.get("state")?.state, { model: "llama/qwen", guidance: "coding", thinking: "low", usage: { input: 2 }, currentTask: "streaming", continuation: "tool-1", output: "hello", outputMode: "text" });
});

test("HTTP run registry exposes lifecycle metrics", () => {
  const registry = new HttpRunRegistry(); const run = registry.register({ id: "metrics" }); assert.deepEqual(registry.metrics(), { active: 1, registered: 1, cancelled: 0, stopping: false }); registry.abort(run.id); registry.abort(run.id); assert.equal(registry.metrics().cancelled, 1); registry.remove(run.id); assert.equal(registry.metrics().active, 0);
});

test("HTTP run registry binds continuation ownership to a run", () => {
  const registry = new HttpRunRegistry(); registry.register({ id: "run", owner: "alice" }); registry.bindContinuation("cont", "run", "alice");
  assert.equal(registry.ownsContinuation("cont", "alice"), true); assert.equal(registry.ownsContinuation("cont", "bob"), false); assert.equal(registry.consumeContinuation("cont", "bob"), false); assert.equal(registry.consumeContinuation("cont", "alice"), true);
});

test("HTTP run registry does not double-count shutdown cancellation", async () => {
  const registry = new HttpRunRegistry(); const run = registry.register({ id: "shutdown-count" }); registry.abort(run.id); await registry.shutdown(); assert.equal(registry.metrics().cancelled, 1);
});

test("HTTP run registry shuts down active runs and cleanup", async () => {
  const registry = new HttpRunRegistry(); let cleaned = 0;
  registry.register({ cleanup: () => { cleaned++; } }); registry.register({ cleanup: () => { cleaned++; } });
  await registry.shutdown();
  assert.equal(registry.size, 0); assert.equal(cleaned, 2); assert.equal(registry.isStopping, true);
  assert.throws(() => registry.register(), /shutting down/);
});
