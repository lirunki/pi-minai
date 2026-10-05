import assert from "node:assert/strict";
import test from "node:test";
import { HttpExtensionRuntime } from "../extensions/http.js";
import type { ModelHostService, RegistryModelRouter } from "../src/index.js";

function router(): RegistryModelRouter { let turn = 0; const host: ModelHostService = { ready: async () => true, invoke: async (input) => ({ model: input.model, text: "local" }), async *stream(input) { if (input.messages.some((message) => message.role === "tool")) { const resumedOriginalRun = input.messages.some((message) => message.role === "tool" && message.toolCallId === "call-1"); const text = resumedOriginalRun ? "continued" : "not resumed"; yield { type: "delta", text }; yield { type: "done", result: { model: input.model, text, finishReason: "stop" } }; return; } if (turn++ === 0 && input.tools) { yield { type: "tool_call", toolCall: { id: "call-1", name: "lookup", arguments: { q: "x" } } }; yield { type: "done", result: { model: input.model, text: "", finishReason: "tool_call" } }; return; } yield { type: "delta", text: "local" }; yield { type: "done", result: { model: input.model, text: "local", finishReason: "stop" } }; } }; return { host: () => host } as unknown as RegistryModelRouter; }

test("local-host runtime serves streaming requests without Pi sessions", async () => { const runtime = new HttpExtensionRuntime({ port: 0, mode: "local-host", modelRouter: router() }); const server = await runtime.start(); const port = (server.address() as { port: number }).port; const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "python-minai/m", stream: true, messages: [{ role: "user", content: "hi" }] }) }); assert.equal(response.status, 200); assert.match(await response.text(), /local/); await runtime.stop(); });

test("local-host runtime pauses and resumes caller tools", async () => { const runtime = new HttpExtensionRuntime({ port: 0, mode: "local-host", modelRouter: router() }); const server = await runtime.start(); const port = (server.address() as { port: number }).port; const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "python-minai/m", stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "lookup", parameters: {} } }] }) }); const pauseText = await first.text(); const frame = JSON.parse(pauseText.trim().replace(/^data: /, "")); const match = frame.choices[0].delta.tool_calls[0].id.match(/^(.+)$/); assert.ok(match); assert.match(pauseText, /finish_reason":"tool_calls/); assert.match(pauseText, /"name":"lookup"/); const second = await fetch(`http://127.0.0.1:${port}/v1/continuations/${match[1]}`, { method: "POST", body: JSON.stringify({ results: { [match[1]!]: "found" } }) }); assert.equal(second.status, 200); assert.match(await second.text(), /continued/); await runtime.stop(); });

test("local-host runtime resumes paused tools from a standard tool-result message", async () => {
  const runtime = new HttpExtensionRuntime({ port: 0, mode: "local-host", modelRouter: router() });
  const server = await runtime.start();
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const tools = [{ type: "function", function: { name: "lookup", parameters: {} } }];
  const first = await fetch(url, { method: "POST", headers: { "x-minai-owner": "alice" }, body: JSON.stringify({ model: "python-minai/m", stream: true, messages: [{ role: "user", content: "hi" }], tools }) });
  const pauseText = await first.text();
  const frame = JSON.parse(pauseText.trim().replace(/^data: /, ""));
  const toolCallId = frame.choices[0].delta.tool_calls[0].id as string;
  const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "", tool_calls: [{ id: toolCallId, type: "function", function: { name: "lookup", arguments: "{}" } }] }, { role: "tool", tool_call_id: toolCallId, content: "found" }];
  const body = JSON.stringify({ model: "python-minai/m", stream: true, messages, tools });
  const unauthorized = await fetch(url, { method: "POST", headers: { "x-minai-owner": "bob" }, body });
  assert.equal(unauthorized.status, 400);
  const resumed = await fetch(url, { method: "POST", headers: { "x-minai-owner": "alice" }, body });
  assert.equal(resumed.status, 200);
  assert.match(await resumed.text(), /continued/);
  await runtime.stop();
});
