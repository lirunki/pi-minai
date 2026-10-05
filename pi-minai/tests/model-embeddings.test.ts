import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleEmbeddingService } from "../src/index.js";

 test("OpenAI-compatible embedding client posts the batch and returns vectors by index", async () => {
  let url = "";
  let authorization = "";
  let body = "";
  const service = new OpenAiCompatibleEmbeddingService({ baseUrl: "http://embed.test/v1/", model: "embed-model", apiKey: "secret" }, async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    body = String(init?.body);
    return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
  });
  assert.deepEqual(await service.embed(["query", "candidate"]), [[1, 0], [0, 1]]);
  assert.equal(url, "http://embed.test/v1/embeddings");
  assert.equal(authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(body), { model: "embed-model", input: ["query", "candidate"] });
});

test("OpenAI-compatible embedding client rejects malformed vector counts", async () => {
  const service = new OpenAiCompatibleEmbeddingService({ baseUrl: "http://embed.test/v1", model: "embed-model" }, async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  await assert.rejects(() => service.embed(["query"]), /unexpected number of vectors/);
});
