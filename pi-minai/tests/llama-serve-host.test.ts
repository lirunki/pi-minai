import assert from "node:assert/strict";
import test from "node:test";
import { LlamaServeHost } from "../src/index.js";
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }); }
function sse(lines: string[]): Response { const encoder = new TextEncoder(); return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(lines.join("\n"))); controller.close(); } })); }

test("llama-serve host supports health and thinking-aware invocation", async () => {
  const calls: RequestInit[] = [];
  const host = new LlamaServeHost({ baseUrl: "http://127.0.0.1:8080", fetch: async (_input, init) => { calls.push(init ?? {}); return String(_input).endsWith("/health") ? response({}) : response({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }); } });
  assert.equal(await host.ready({ provider: "llama-serve", id: "m" }), true);
  const result = await host.invoke({ model: { provider: "llama-serve", id: "m" }, messages: [], thinking: "high" });
  assert.equal(result.text, "ok");
  assert.match(String(calls[1]!.body), /reasoning_effort/);
});

test("llama-serve host serializes tools in OpenAI function format", async () => {
  const calls: RequestInit[] = [];
  const host = new LlamaServeHost({ baseUrl: "http://x", fetch: (async (url: unknown, init?: RequestInit) => { calls.push(init ?? {}); return response({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] }); }) as typeof fetch });
  await host.invoke({ model: { provider: "llama-serve", id: "m" }, messages: [], tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }] });
  const payload = JSON.parse(String(calls[0]!.body)) as { tools: Array<{ type: string; function: { name: string } }> };
  assert.equal(payload.tools[0]!.type, "function");
  assert.equal(payload.tools[0]!.function.name, "read");
});

test("llama-serve host preserves thinking and text streaming", async () => {
  const host = new LlamaServeHost({ baseUrl: "http://127.0.0.1:8080", fetch: async () => sse(['data: {"choices":[{"delta":{"reasoning_content":"think"}}]}', 'data: {"choices":[{"delta":{"content":"answer"}}]}', "data: [DONE]"]) });
  const events = [];
  for await (const event of host.stream({ model: { provider: "llama-serve", id: "m" }, messages: [], thinking: "low" })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["thinking_delta", "delta", "done"]);
});

import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execPath } from "node:process";
import { RemoteOpenAiHost, hfSpawnOptions, piCatalogApiKey, type LlamaServeProcessOptions } from "../src/index.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

test("llama-serve hosts adopt an already-running endpoint and never spawn", async () => {
  const server: Server = createServer((request, response) => {
    if (request.url === "/health") { response.end("ok"); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "lazy-ok" }, finish_reason: "stop" }] }));
  });
  const port = await listen(server);
  try {
    const host = new LlamaServeHost({ baseUrl: `http://127.0.0.1:${port}`, process: { command: execPath, args: ["-e", "setInterval(() => {}, 1000)"], startupTimeoutMs: 5000, shutdownTimeoutMs: 500 } });
    await host.start();
    assert.equal(host.managedProcess?.running, false); // not started with the runtime
    assert.equal(await host.ready({ provider: "llama-serve", id: "m" }), true);
    const result = await host.invoke({ model: { provider: "llama-serve", id: "m" }, messages: [] });
    assert.equal(result.text, "lazy-ok");
    assert.equal(host.managedProcess?.running, false); // healthy endpoint was adopted, not spawned
    await host.stop();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("llama-serve hosts spawn their managed process on first model use when the endpoint is down", async () => {
  const server: Server = createServer((_request, response) => response.writeHead(500).end()); // nothing usable on the port
  const port = await listen(server);
  const marker = path.join(os.tmpdir(), `minai-lazy-spawn-${Date.now()}.marker`);
  try {
    const host = new LlamaServeHost({ baseUrl: `http://127.0.0.1:${port}`, process: { command: execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setInterval(() => {}, 1000)`], startupTimeoutMs: 800, shutdownTimeoutMs: 500 } });
    await host.start();
    assert.equal(host.managedProcess?.running, false);
    await assert.rejects(host.invoke({ model: { provider: "llama-serve", id: "m" }, messages: [] }), /did not become ready/i);
    assert.equal(readFileSync(marker, "utf8"), "x"); // child spawned during the invoke attempt
    await host.stop();
  } finally {
    rmSync(marker, { force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("hf process options gain download args and the cache folder env", () => {
  const options = hfSpawnOptions({ command: "/bin/llama-server", hfRepo: "microsoft/Phi-3-mini-4k-instruct-gguf", hfFile: "Phi-3-mini-4k-instruct-q4.gguf", cacheDir: "/tmp/minai-cache", args: ["--port", "9201"] });
  assert.deepEqual(options.args, ["-hf", "microsoft/Phi-3-mini-4k-instruct-gguf", "-hff", "Phi-3-mini-4k-instruct-q4.gguf", "--port", "9201"]);
  assert.equal(options.env?.LLAMA_CACHE, "/tmp/minai-cache");
  const plain: LlamaServeProcessOptions = { command: "/bin/llama-server", args: ["-m", "x.gguf"] };
  assert.deepEqual(hfSpawnOptions(plain).args, ["-m", "x.gguf"]);
});

test("remote openai hosts report not-ready on auth failures", async () => {
  const server: Server = createServer((request, response) => {
    response.writeHead(request.headers.authorization === "Bearer good-key" ? 200 : 401).end(JSON.stringify({ error: { message: "Invalid API key." } }));
  });
  const port = await listen(server);
  try {
    process.env.MINAI_TEST_REMOTE_KEY = "good-key";
    const host = new RemoteOpenAiHost({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "MINAI_TEST_REMOTE_KEY" });
    assert.equal(await host.ready({ provider: "x", id: "m" }), true);
    process.env.MINAI_TEST_REMOTE_KEY = "stale-key";
    const stale = new RemoteOpenAiHost({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "MINAI_TEST_REMOTE_KEY" });
    assert.equal(await stale.ready({ provider: "x", id: "m" }), false); // bad key drops out of routing
  } finally {
    delete process.env.MINAI_TEST_REMOTE_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("hosts resolve missing env keys from the shared Pi model catalog", async () => {
  const catalog = path.join(os.tmpdir(), `minai-catalog-${Date.now()}`);
  mkdirSync(catalog, { recursive: true });
  writeFileSync(path.join(catalog, "models.json"), JSON.stringify({ providers: { cheaperinference: { apiKey: "  catalog-secret " } } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = catalog;
  try {
    assert.equal(piCatalogApiKey("cheaperinference"), "catalog-secret"); // trims whitespace
    assert.equal(piCatalogApiKey("nonexistent"), undefined);
    const seen: Array<string | null> = [];
    const server: Server = createServer((request, response) => {
      seen.push(request.headers.authorization ?? null);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(request.url?.includes("chat") ? { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } : { data: [] }));
    });
    const port = await listen(server);
    try {
      const host = new RemoteOpenAiHost({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "MINAI_ABSENT_KEY", apiKeyCatalog: "cheaperinference" });
      assert.equal(await host.ready({ provider: "x", id: "m" }), true); // probed with the catalog key
      await host.invoke({ model: { provider: "x", id: "m" }, messages: [] });
      assert.ok(seen.every((auth) => auth === "Bearer catalog-secret"));
      process.env.MINAI_ABSENT_KEY = "env-wins";
      const override = new RemoteOpenAiHost({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "MINAI_ABSENT_KEY", apiKeyCatalog: "cheaperinference" });
      await override.invoke({ model: { provider: "x", id: "m" }, messages: [] });
      assert.equal(seen[seen.length - 1], "Bearer env-wins"); // explicit env still wins
      delete process.env.MINAI_ABSENT_KEY;
      const orphan = new RemoteOpenAiHost({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "MINAI_ABSENT_KEY", apiKeyCatalog: "no-such-provider" });
      await assert.rejects(orphan.invoke({ model: { provider: "x", id: "m" }, messages: [] }), /providers\.no-such-provider\.apiKey/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(catalog, { recursive: true, force: true });
  }
});

test("remote openai hosts probe reachability and send env-resolved bearer keys", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const server: Server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", auth: request.headers.authorization ?? null });
    response.writeHead(request.url === "/missing" ? 404 : 200).end(JSON.stringify(request.url?.includes("chat") ? { choices: [{ message: { content: "remote-ok" }, finish_reason: "stop" }] } : { data: [] }));
  });
  const port = await listen(server);
  try {
    process.env.MINAI_TEST_REMOTE_KEY = "secret-key";
    const host = new RemoteOpenAiHost({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "MINAI_TEST_REMOTE_KEY" });
    assert.equal(await host.ready({ provider: "x", id: "glm-5.3-flash" }), true); // 404 still means reachable
    const result = await host.invoke({ model: { provider: "x", id: "glm-5.3-flash" }, messages: [] });
    assert.equal(result.text, "remote-ok");
    assert.deepEqual(seen.map((call) => call.url), ["/v1/models", "/v1/chat/completions"]);
    assert.equal(seen[1]!.auth, "Bearer secret-key");
    delete process.env.MINAI_TEST_REMOTE_KEY;
    await assert.rejects(host.invoke({ model: { provider: "x", id: "glm-5.3-flash" }, messages: [] }), /MINAI_TEST_REMOTE_KEY/);
  } finally {
    delete process.env.MINAI_TEST_REMOTE_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
