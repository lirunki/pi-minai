import assert from "node:assert/strict";
import test from "node:test";
import { MinaiHttpHandler } from "../src/index.js";
import type { HttpExecutionServices } from "../src/index.js";

const services: HttpExecutionServices = {
  async complete(request) { return { requestId: request.requestId, model: request.model, text: "hello", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; },
  async *stream(request) { yield { type: "text_delta", requestId: request.requestId, model: request.model, delta: "hi" }; yield { type: "done", result: { requestId: request.requestId, model: request.model, text: "hi", finishReason: "stop" } }; },
};

test("listener serves health and OpenAI non-stream responses", async () => {
  const handler = new MinaiHttpHandler(services);
  assert.deepEqual(await (await handler.handle(new Request("http://localhost/health"))).json(), { status: "ok" });
  const response = await handler.handle(new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "p/m", messages: [{ role: "user", content: "hi" }] }) }));
  assert.equal(response.status, 200);
  const body = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]!.message.content, "hello");
});

test("listener formats OpenAI SSE and Ollama NDJSON", async () => {
  const handler = new MinaiHttpHandler(services);
  const openai = await handler.handle(new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }) }));
  assert.equal(openai.headers.get("content-type"), "text/event-stream");
  assert.match(await openai.text(), /data:.*text_delta|data:.*hi/);
  const ollama = await handler.handle(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) }));
  assert.equal(ollama.headers.get("content-type"), "application/x-ndjson");
  assert.match(await ollama.text(), /"done":true/);
});

test("listener enforces auth, body limits, and route methods", async () => {
  const handler = new MinaiHttpHandler(services, { bearerToken: "secret", maxBodyBytes: 20 });
  assert.equal((await handler.handle(new Request("http://localhost/health", { headers: { authorization: "Bearer bad" } }))).status, 401);
  assert.equal((await handler.handle(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer secret" }, body: "x".repeat(30) }))).status, 400);
  assert.equal((await handler.handle(new Request("http://localhost/unknown", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }))).status, 404);
});

test("listener dispatches continuation results", async () => {
  const continuation = {
    async *start() { yield { type: "tool_pause_batch", requestId: "r", model: { provider: "p", id: "m" }, calls: [] as never[] }; },
    async *resumeBatch(results: Record<string, unknown>) { assert.deepEqual(results, { c1: "done" }); yield { type: "done", result: { requestId: "r", model: { provider: "p", id: "m" }, text: "resumed", finishReason: "stop" } }; },
  };
  const handler = new MinaiHttpHandler({ ...services, continuation });
  const response = await handler.handle(new Request("http://localhost/v1/continuations/c1", { method: "POST", body: JSON.stringify({ results: { c1: "done" } }) }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /finish_reason/);
});

test("listener emits terminal error frame with finish_reason when stream fails", async () => {
  const failing: HttpExecutionServices = {
    async complete(request) { return { requestId: request.requestId, model: request.model, text: "", finishReason: "stop" }; },
    async *stream(request) { yield { type: "text_delta", requestId: request.requestId, model: request.model, delta: "partial" }; throw new Error("llama exploded mid-plan"); },
  };
  const handler = new MinaiHttpHandler(failing);
  const response = await handler.handle(new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "p/m", stream: true, messages: [{ role: "user", content: "hi" }] }) }));
  const text = await response.text();
  assert.match(text, /partial/);
  const frames = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> });
  const terminal = frames.at(-1)!;
  assert.equal(terminal.choices?.[0]?.finish_reason, "error");
  assert.match(terminal.choices?.[0]?.delta?.content ?? "", /llama exploded mid-plan/);
});

test("listener streams minai_error text before finish_reason error", async () => {
  const failing: HttpExecutionServices = {
    async complete(request) { return { requestId: request.requestId, model: request.model, text: "", finishReason: "stop" }; },
    async *stream(request) { throw new Error("boom"); },
  };
  const handler = new MinaiHttpHandler(failing);
  const response = await handler.handle(new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "p/m", stream: true, messages: [{ role: "user", content: "hi" }] }) }));
  const text = await response.text();
  assert.match(text, /finish_reason":"error/);
});
