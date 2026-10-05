import assert from "node:assert/strict";
import test from "node:test";
import { MinaiHttpHandler, startMinaiHttpServer } from "../src/index.js";
import type { HttpExecutionServices } from "../src/index.js";

const services: HttpExecutionServices = {
  async complete(request) { return { requestId: request.requestId, model: request.model, text: "server-ok", finishReason: "stop" }; },
  async *stream(request) { yield { type: "text_delta", requestId: request.requestId, model: request.model, delta: "s" }; yield { type: "done", result: { requestId: request.requestId, model: request.model, text: "s", finishReason: "stop" } }; },
};

test("Node server bridge serves real fetch requests and closes", async () => {
  const listener = await startMinaiHttpServer(new MinaiHttpHandler(services), { port: 0 });
  const address = listener.address();
  assert.equal(typeof address, "object");
  const port = (address as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /server-ok/);
  await listener.close();
});
