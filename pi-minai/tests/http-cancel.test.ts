import assert from "node:assert/strict";
import test from "node:test";
import { MinaiHttpHandler, HttpRunRegistry } from "../src/index.js";

test("HTTP cancellation route aborts an owned run", async () => {
  const runs = new HttpRunRegistry(); const run = runs.register({ id: "r1", owner: "client" });
  const handler = new MinaiHttpHandler({ complete: async () => { throw new Error(); }, stream: async function* () {} }, {}, runs);
  const response = await handler.handle(new Request("http://localhost/v1/runs/r1/cancel", { method: "POST", headers: { "x-minai-owner": "client" } }));
  assert.equal(response.status, 200); assert.equal(run.controller.signal.aborted, true);
});

test("HTTP cancellation route rejects unknown or foreign runs", async () => {
  const runs = new HttpRunRegistry(); runs.register({ id: "r1", owner: "client" });
  const handler = new MinaiHttpHandler({ complete: async () => { throw new Error(); }, stream: async function* () {} }, {}, runs);
  assert.equal((await handler.handle(new Request("http://localhost/v1/runs/r1/cancel", { method: "POST", headers: { "x-minai-owner": "other" } }))).status, 404);
  assert.equal((await handler.handle(new Request("http://localhost/v1/runs/nope/cancel", { method: "POST" }))).status, 404);
});
