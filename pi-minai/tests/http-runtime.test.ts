import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestSessionRegistry } from "../src/index.js";
import type { PiSessionLike } from "../src/index.js";

function fakeSession(): PiSessionLike & { aborted: number; disposed: number } { return { aborted: 0, disposed: 0, prompt: async () => {}, subscribe: () => () => {}, abort: async function () { this.aborted++; }, dispose: function () { this.disposed++; } }; }

test("HTTP registry creates independent request-owned sessions concurrently", async () => {
  const sessions: Array<ReturnType<typeof fakeSession>> = [];
  const registry = new HttpRequestSessionRegistry(async () => { const session = fakeSession(); sessions.push(session); return session; });
  const seen = await Promise.all([registry.run(async (run) => run.id), registry.run(async (run) => run.id)]);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(registry.size, 0);
  assert.deepEqual(sessions.map((session) => session.disposed), [1, 1]);
});

test("HTTP registry aborts and disposes active runs on shutdown", async () => {
  const session = fakeSession();
  const registry = new HttpRequestSessionRegistry(async () => session);
  let finished = false;
  const running = registry.run(async (run) => { await new Promise<void>((resolve) => run.abortController.signal.addEventListener("abort", () => { finished = true; resolve(); }, { once: true })); });
  while (registry.size === 0) await new Promise((resolve) => setImmediate(resolve));
  await registry.shutdown();
  await running;
  assert.equal(finished, true);
  assert.equal(session.aborted, 1);
  assert.equal(session.disposed, 1);
});
