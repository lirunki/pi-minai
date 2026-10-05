import assert from "node:assert/strict";
import test from "node:test";
import { MinaiHttpHandler, HttpRunRegistry } from "../src/index.js";

const services = { complete: async () => { throw new Error(); }, stream: async function* () {} };

test("metrics follows HTTP bearer authentication", async () => {
  const handler = new MinaiHttpHandler(services, { bearerToken: "secret" }, new HttpRunRegistry());
  assert.equal((await handler.handle(new Request("http://localhost/metrics"))).status, 401);
  assert.equal((await handler.handle(new Request("http://localhost/metrics", { headers: { authorization: "Bearer secret" } }))).status, 200);
});
