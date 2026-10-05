import assert from "node:assert/strict";
import test from "node:test";
import { HttpExtensionRuntime } from "../extensions/http.js";
import { createPiHttpExecutionServices } from "../src/index.js";
import type { ModelHostService, PiSessionLike, RegistryModelRouter } from "../src/index.js";

function session(): PiSessionLike { return { prompt: async () => {}, subscribe: (listener) => { listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pi-answer" } }); return () => {}; }, abort: async () => {}, dispose: () => {} }; }
const host: ModelHostService = { ready: async () => true, invoke: async (input) => ({ model: input.model, text: "local-answer", finishReason: "stop" }), async *stream(input) { yield { type: "done", result: { model: input.model, text: "local-answer", finishReason: "stop" } }; } };
const router = { host: () => host } as unknown as RegistryModelRouter;

async function portOf(runtime: HttpExtensionRuntime): Promise<number> { const server = await runtime.start(); return (server.address() as { port: number }).port; }

test("public HTTP contract works through Pi and local-host runtime modes", async () => {
  const pi = new HttpExtensionRuntime({ port: 0, services: createPiHttpExecutionServices({ createSession: async () => session() }) });
  const local = new HttpExtensionRuntime({ port: 0, mode: "local-host", modelRouter: router });
  try {
    for (const [port, expected] of [[await portOf(pi), "pi-answer"], [await portOf(local), "local-answer"]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "python-minai/m", messages: [{ role: "user", content: "hello" }] }) });
      assert.equal(response.status, 200); const body = await response.json() as { choices: Array<{ message: { content: string } }> }; assert.equal(body.choices[0]!.message.content, expected);
    }
  } finally { await pi.stop(); await local.stop(); }
});
