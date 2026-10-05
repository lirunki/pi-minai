import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpExtensionRuntime } from "../extensions/http.js";

test("registry-backed model=auto short-circuits a single eligible model", async () => {
  let completionCalls = 0;
  const hostServer = createServer((request, response) => {
    if (request.url === "/health") { response.writeHead(200).end("ok"); return; }
    if (request.url === "/v1/chat/completions") {
      completionCalls++;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "auto-result" }, finish_reason: "stop" }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
  const hostPort = (hostServer.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), "minai-auto-registry-"));
  const registryPath = join(directory, "models.json");
  await writeFile(registryPath, JSON.stringify({
    hosts: { local: { backend: "llama-serve", baseUrl: `http://127.0.0.1:${hostPort}` } },
    models: [{ provider: "local", id: "chat", host: "local", locality: "local", availability: "ready", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: true, vision: false, reasoning: false, streaming: true } }],
  }));
  const runtime = new HttpExtensionRuntime({ port: 0, mode: "local-host", registryPath, planning: false });
  try {
    const server = await runtime.start();
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "answer" }] }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /auto-result/);
    assert.equal(completionCalls, 1, "the one-candidate shortcut should skip the LLM classifier");
  } finally {
    await runtime.stop();
    await new Promise<void>((resolve, reject) => hostServer.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry-backed model=auto falls back to the model-host JEV classifier", async () => {
  const modelCalls: string[] = [];
  const hostServer = createServer((request, response) => {
    if (request.url === "/health") { response.writeHead(200).end("ok"); return; }
    if (request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
      modelCalls.push(body.model);
      const content = body.model === "classifier" ? '{"answers":{"model":{"choice":"remote/answer","confidence":0.9}}}' : "answer-selected";
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
  const hostPort = (hostServer.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), "minai-auto-jev-"));
  const registryPath = join(directory, "models.json");
  await writeFile(registryPath, JSON.stringify({
    hosts: { local: { backend: "llama-serve", baseUrl: `http://127.0.0.1:${hostPort}` } },
    models: [
      { provider: "local", id: "classifier", host: "local", locality: "local", availability: "ready", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: true, vision: false, reasoning: false, streaming: true } },
      { provider: "remote", id: "answer", host: "local", locality: "remote", availability: "ready", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: true, vision: false, reasoning: false, streaming: true } },
    ],
  }));
  const runtime = new HttpExtensionRuntime({ port: 0, mode: "local-host", registryPath, planning: false });
  try {
    const server = await runtime.start();
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "choose a model" }] }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /answer-selected/);
    assert.deepEqual(modelCalls, ["classifier", "answer"]);
  } finally {
    await runtime.stop();
    await new Promise<void>((resolve, reject) => hostServer.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
