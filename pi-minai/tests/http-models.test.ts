import assert from "node:assert/strict";
import test from "node:test";
import { MinaiHttpHandler } from "../src/index.js";

test("HTTP model listing routes expose OpenAI and Ollama catalogs", async () => {
  const handler = new MinaiHttpHandler({ complete: async () => { throw new Error(); }, stream: async function* () {}, listModels: () => [{ provider: "python-minai", id: "m", locality: "local", availability: "ready", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: false, vision: false, reasoning: true, streaming: true } }] });
  const openai = await handler.handle(new Request("http://localhost/v1/models")); const openaiBody = await openai.json() as { data: Array<{ id: string }> }; assert.equal(openaiBody.data[0]!.id, "python-minai/m");
  const ollama = await handler.handle(new Request("http://localhost/api/tags")); const ollamaBody = await ollama.json() as { models: Array<{ name: string }> }; assert.equal(ollamaBody.models[0]!.name, "m");
});
