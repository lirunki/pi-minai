import assert from "node:assert/strict";
import test from "node:test";
import { MinaiHttpHandler, HttpRunRegistry } from "../src/index.js";

test("HTTP metrics route reports active run lifecycle", async () => {
  const runs = new HttpRunRegistry(); runs.register({ id: "active" });
  const handler = new MinaiHttpHandler({ complete: async () => { throw new Error(); }, stream: async function* () {} }, {}, runs);
  const response = await handler.handle(new Request("http://localhost/metrics"));
  assert.deepEqual(await response.json(), { http_runs: { active: 1, registered: 1, cancelled: 0, stopping: false } });
});
