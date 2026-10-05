import assert from "node:assert/strict";
import test from "node:test";
import { HttpExtensionRuntime } from "../extensions/http.js";
import type { ModelHostService, RegistryModelRouter } from "../src/index.js";

test("local-host runtime resolves model=auto through the registry", async () => {
  let selected = "";
  const host: ModelHostService = { ready: async () => true, invoke: async (input) => { selected = input.model.id; return { model: input.model, text: "auto-result" }; }, async *stream() { yield { type: "done", result: { model: { provider: "python-minai", id: "chosen" }, text: "", finishReason: "stop" } }; } };
  const modelRouter = { select: async () => ({ model: { provider: "python-minai", id: "chosen" }, source: "fallback", candidates: [] }), host: () => host } as unknown as RegistryModelRouter;
  const runtime = new HttpExtensionRuntime({ port: 0, mode: "local-host", classifierModel: "classifier", modelRouter }); const server = await runtime.start(); const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "choose" }] }) });
  assert.equal(response.status, 200); assert.match(await response.text(), /auto-result/); assert.equal(selected, "chosen"); await runtime.stop();
});
