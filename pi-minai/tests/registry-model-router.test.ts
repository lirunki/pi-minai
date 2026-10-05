import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileModelHostRegistry, RegistryModelRouter } from "../src/index.js";

const model = { provider: "llama-serve", id: "m", host: "llama", locality: "local", availability: "ready", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: false, vision: false, reasoning: true, streaming: true } };

test("registry router selects and resolves the filesystem host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minai-router-")); const path = join(directory, "models.json");
  await writeFile(path, JSON.stringify({ hosts: { llama: { backend: "llama-serve", baseUrl: "http://127.0.0.1:9200" } }, models: [model] }));
  const router = new RegistryModelRouter(await FileModelHostRegistry.load(path));
  const selection = await router.select({ query: "hello", classifierModel: "classifier", requestedModel: { provider: "llama-serve", id: "m" } });
  assert.deepEqual(selection.model, { provider: "llama-serve", id: "m" });
  assert.equal(router.host(selection.model).constructor.name, "LlamaServeHost");
});
