import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileModelHostRegistry } from "../src/index.js";

const model = { provider: "python-minai", id: "m", host: "py", locality: "local", availability: "ready", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: true, vision: false, reasoning: true, streaming: true } };

test("filesystem registry loads hosts and maps models to hosters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minai-hosts-"));
  const path = join(directory, "hosts.json");
  await writeFile(path, JSON.stringify({ hosts: { py: { backend: "python-minai", baseUrl: "http://127.0.0.1:9100" }, llama: { backend: "llama-serve", baseUrl: "http://127.0.0.1:9200" } }, models: [model] }));
  const registry = await FileModelHostRegistry.load(path);
  assert.deepEqual(registry.listHosts(), ["py", "llama"]);
  assert.equal(registry.listModels()[0]!.id, "m");
  assert.equal(registry.getModelHost({ provider: "python-minai", id: "m" }).constructor.name, "PythonMinaiHost");
});

test("filesystem registry rejects unknown model hosts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minai-hosts-"));
  const path = join(directory, "bad.json");
  await writeFile(path, JSON.stringify({ hosts: {}, models: [model] }));
  await assert.rejects(FileModelHostRegistry.load(path), /unknown host/);
});

test("registry accepts openai hosts and builds remote clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minai-hosts-openai-"));
  const good = join(directory, "hosts.json");
  await writeFile(good, JSON.stringify({ hosts: { remote: { backend: "openai", baseUrl: "https://api.example.com/v1", chatPath: "/chat/completions", apiKeyEnv: "MINAI_TEST_REMOTE_KEY" } }, models: [{ provider: "remote", id: "glm-5.3-flash", host: "remote", locality: "remote", availability: "ready", contextWindow: 131072, maxOutputTokens: 8192, capabilities: { tools: true, vision: false, reasoning: false, streaming: true } }] }));
  const registry = await FileModelHostRegistry.load(good);
  const { RemoteOpenAiHost } = await import("../src/index.js");
  assert.ok(registry.getModelHost({ provider: "remote", id: "glm-5.3-flash" }) instanceof RemoteOpenAiHost);
  assert.equal(registry.listModels()[0]!.id, "glm-5.3-flash");

  const bad = join(directory, "bad.json");
  await writeFile(bad, JSON.stringify({ hosts: { x: { backend: "wat", baseUrl: "http://x" } }, models: [] }));
  await assert.rejects(FileModelHostRegistry.load(bad), /unsupported backend/i);
});
