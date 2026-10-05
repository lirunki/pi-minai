import assert from "node:assert/strict";
import test from "node:test";
import { PythonMinaiHost } from "../src/index.js";

function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function streamResponse(lines: string[]): Response { const encoder = new TextEncoder(); return new Response(new ReadableStream({ start(controller) { for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`)); controller.close(); } })); }

test("Python host checks health and invokes through loopback HTTP", async () => {
  const requests: string[] = [];
  const host = new PythonMinaiHost({ baseUrl: "http://127.0.0.1:9000", fetch: async (input, init) => { requests.push(`${init?.method ?? "GET"} ${input}`); return String(input).endsWith("/health") ? response({ status: "ok", state: "ready" }) : response({ text: "hello", finish_reason: "stop", usage: { input_tokens: 2, output_tokens: 3 } }); } });
  assert.equal(await host.ready({ provider: "python-minai", id: "m" }), true);
  const result = await host.invoke({ model: { provider: "python-minai", id: "m" }, messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.text, "hello");
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3 });
  assert.deepEqual(requests, ["GET http://127.0.0.1:9000/health", "POST http://127.0.0.1:9000/v1/generate"]);
});

test("Python host decodes NDJSON streaming events", async () => {
  const host = new PythonMinaiHost({ baseUrl: "http://127.0.0.1:9000", fetch: async () => streamResponse(['{"type":"delta","text":"a"}', '{"type":"delta","text":"b"}', '{"type":"done","finish_reason":"stop","input_tokens":4,"output_tokens":2}']) });
  const events = [];
  for await (const event of host.stream({ model: { provider: "python-minai", id: "m" }, messages: [] })) events.push(event);
  assert.equal(events[0]!.type, "delta");
  assert.equal(events[1]!.type, "delta");
  assert.equal(events[2]!.type, "done");
});

test("Python host reports HTTP failures", async () => {
  const host = new PythonMinaiHost({ baseUrl: "http://127.0.0.1:9000", fetch: async () => response({}, 503) });
  await assert.rejects(host.invoke({ model: { provider: "python-minai", id: "m" }, messages: [] }), (error: { code: string }) => error.code === "python_host_http");
});
