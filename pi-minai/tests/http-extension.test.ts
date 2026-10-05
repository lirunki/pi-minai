import assert from "node:assert/strict";
import test from "node:test";
import { HttpExtensionRuntime, registerMinaiProvider } from "../extensions/http.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSessionLike } from "../src/index.js";

function session(): PiSessionLike { let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined; return { prompt: async () => { listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "automatic" } }); }, subscribe: (next) => { listener = next; return () => { listener = undefined; }; }, abort: async () => {}, dispose: () => {} }; }

test("start_http registration exposes the minai model to Pi", () => {
  let registration: { name: string; config: { baseUrl?: string; models?: Array<{ id: string; name?: string }> } } | undefined;
  registerMinaiProvider({ registerProvider: (name, config) => { registration = { name, config }; } } as unknown as ExtensionAPI, { port: 4321 });
  assert.equal(registration?.name, "minai");
  assert.equal(registration?.config.baseUrl, "http://127.0.0.1:4321/v1");
  assert.equal(registration?.config.models?.[0]?.id, "minai");
  assert.equal(registration?.config.models?.[0]?.name, "MINAI");
});

test("HTTP extension automatically builds execution services", async () => {
  const created: string[] = [];
  const runtime = new HttpExtensionRuntime({ port: 0, createRequestSession: async ({ id }) => { created.push(id); return session(); } });
  const server = await runtime.start();
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] }) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /automatic/);
  assert.equal(created.length, 1);
  await runtime.stop();
});
