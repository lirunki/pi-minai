import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execPath } from "node:process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HttpExtensionRuntime } from "../extensions/http.js";
import { LocalRankingHosts, loadLocalRankingHostsOptions, localRankingSidecarProcessOptions, parseLocalRankingHostsOptions, type RegistryModelRouter } from "../src/index.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

test("local ranking sidecar options parse from a config document", () => {
  assert.equal(parseLocalRankingHostsOptions({}), undefined);
  assert.equal(parseLocalRankingHostsOptions({ ranking: null }), undefined);

  const options = parseLocalRankingHostsOptions({ ranking: { embedding: { modelPath: "/models/emb.gguf" } } })!;
  assert.equal(options.embedding?.port, 9300);
  assert.equal(options.embedding?.alias, "qwen3-embedding-0.6b");
  assert.equal(options.embedding?.modelPath, "/models/emb.gguf");
  assert.equal(options.reranker, undefined);

  const both = parseLocalRankingHostsOptions({ ranking: {
    cacheDir: "~/ranking-cache",
    embedding: { hfRepo: "ggml-org/embedding", hfFile: "model-Q8_0.gguf", alias: "my-embed", port: 9400 },
    reranker: { modelPath: "/models/rerank.gguf", command: "/custom/llama-server", startupTimeoutMs: 5000 },
  } })!;
  assert.equal(both.embedding?.hfRepo, "ggml-org/embedding");
  assert.equal(both.embedding?.hfFile, "model-Q8_0.gguf");
  assert.equal(both.embedding?.modelPath, undefined);
  assert.equal(both.embedding?.alias, "my-embed");
  assert.equal(both.embedding?.port, 9400);
  assert.match(both.embedding?.cacheDir ?? "", /ranking-cache$/); // ~ expanded, inherited from ranking.cacheDir
  assert.equal(both.reranker?.modelPath, "/models/rerank.gguf");
  assert.equal(both.reranker?.alias, "bge-reranker-v2-m3");
  assert.equal(both.reranker?.port, 9301);
  assert.match(both.reranker?.cacheDir ?? "", /ranking-cache$/);
  assert.equal(both.reranker?.command, "/custom/llama-server");
  assert.equal(both.reranker?.startupTimeoutMs, 5000);
  assert.equal(both.embedding?.eager, false); // embedding sidecars are lazy by default
  assert.equal(both.reranker?.eager, true); // rerankers have no internal caller, so they default to eager

  const explicitEager = parseLocalRankingHostsOptions({ ranking: { embedding: { modelPath: "a", eager: true } } })!;
  assert.equal(explicitEager.embedding?.eager, true);

  assert.throws(() => parseLocalRankingHostsOptions({ ranking: "nope" }), /must be an object/i);
  assert.throws(() => parseLocalRankingHostsOptions({ ranking: {} }), /must define embedding or reranker/i);
  assert.throws(() => parseLocalRankingHostsOptions({ ranking: { embedding: {} } }), /must define modelPath or hfRepo/i);
  assert.throws(() => parseLocalRankingHostsOptions({ ranking: { embedding: { modelPath: "a", hfRepo: "b" } } }), /only one/i);
  assert.throws(() => parseLocalRankingHostsOptions({ ranking: { embedding: { modelPath: "a", port: 0 } } }), /TCP port/i);
  assert.throws(() => parseLocalRankingHostsOptions({ ranking: { embedding: { hfFile: "x.gguf" } } }), /modelPath or hfRepo/i);
  assert.throws(() => parseLocalRankingHostsOptions({ ranking: { embedding: { modelPath: "a", hfFile: "x.gguf" } } }), /hfFile requires/i);
  assert.throws(() => parseLocalRankingHostsOptions({ ranking: { cacheDir: "  " } }), /cacheDir/i);
});

test("sidecar spawn plan points llama-server at the cache folder for HF downloads", () => {
  const hf = localRankingSidecarProcessOptions(parseLocalRankingHostsOptions({ ranking: { embedding: { hfRepo: "ggml-org/Qwen3-Embedding-0.6B-GGUF:Q8_0" } } })!.embedding!);
  assert.deepEqual(hf.args, ["-hf", "ggml-org/Qwen3-Embedding-0.6B-GGUF:Q8_0", "--embedding", "--pooling", "mean", "--host", "127.0.0.1", "--port", "9300", "--alias", "qwen3-embedding-0.6b", "--no-webui"]);
  assert.equal(hf.env?.LLAMA_CACHE, path.join(os.homedir(), ".cache", "minai", "llama"));
  assert.equal(hf.startupTimeoutMs, 600_000); // generous default while the first download runs

  const local = localRankingSidecarProcessOptions({ kind: "reranker", port: 9301, alias: "r", modelPath: "/models/r.gguf", cacheDir: path.join(os.tmpdir(), "minai-ranking-test-cache") });
  assert.deepEqual(local.args, ["-m", "/models/r.gguf", "--rerank", "--host", "127.0.0.1", "--port", "9301", "--alias", "r", "--no-webui"]);
  assert.equal(local.startupTimeoutMs, 120_000);

  const pinned = localRankingSidecarProcessOptions({ kind: "embedding", port: 9300, alias: "e", hfRepo: "org/repo", hfFile: "m.gguf", cacheDir: path.join(os.tmpdir(), "minai-ranking-test-cache") });
  assert.deepEqual(pinned.args?.slice(0, 4), ["-hf", "org/repo", "-hff", "m.gguf"]);
});

test("local ranking options load from the registry config file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "minai-ranking-"));
  try {
    const registry = path.join(dir, "models.json");
    writeFileSync(registry, JSON.stringify({ hosts: {}, models: [], ranking: { embedding: { hfRepo: "ggml-org/embedding" } } }));
    const options = loadLocalRankingHostsOptions(registry)!;
    assert.equal(options.embedding?.hfRepo, "ggml-org/embedding");
    assert.equal(loadLocalRankingHostsOptions(path.join(dir, "missing.json")), undefined);

    writeFileSync(registry, "{ not json");
    assert.throws(() => loadLocalRankingHostsOptions(registry), /Could not read local ranking config/i);

    writeFileSync(registry, JSON.stringify({ ranking: { embedding: { modelPath: 7 } } }));
    assert.throws(() => loadLocalRankingHostsOptions(registry), /must define modelPath or hfRepo/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embedding sidecars start lazily on the first embed request", async () => {
  const vectors = [[0.1, 0.2], [0.3, 0.4]];
  const server: Server = createServer((request, response) => {
    if (request.url === "/health") { response.end("ok"); return; }
    let payload = "";
    request.on("data", (chunk) => (payload += chunk));
    request.on("end", () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) })));
  });
  const port = await listen(server);
  try {
    const hosts = new LocalRankingHosts({ embedding: { kind: "embedding", port, alias: "e", modelPath: "/models/emb.gguf", cacheDir: path.join(os.tmpdir(), "minai-ranking-test-cache"), command: execPath, eager: false } });
    await hosts.start(); // lazy: nothing spawned
    assert.equal(hosts.process("embedding"), undefined);
    const service = hosts.embedding();
    const result = await service.embed(["q", "d"]);
    assert.deepEqual(result, vectors); // adopted the healthy endpoint
    assert.equal(hosts.process("embedding")?.running, false);
    await hosts.stop();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("local ranking hosts adopt a healthy endpoint and stop owned processes", async () => {
  const server: Server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const hosts = new LocalRankingHosts({ embedding: { kind: "embedding", port, alias: "e", modelPath: "/models/emb.gguf", cacheDir: path.join(os.tmpdir(), "minai-ranking-test-cache"), command: execPath, eager: true } });
    await hosts.start();
    assert.equal(hosts.process("embedding")!.running, false); // healthy endpoint was adopted, not spawned
    assert.equal(hosts.embeddingBaseUrl, `http://127.0.0.1:${port}/v1`);
    assert.equal(hosts.embeddingModel, "e");
    await hosts.stop();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const failing = new LocalRankingHosts({ embedding: { kind: "embedding", port: 9399, alias: "e", modelPath: "/models/emb.gguf", cacheDir: path.join(os.tmpdir(), "minai-ranking-test-cache"), command: execPath, startupTimeoutMs: 1_000, eager: true } });
  await assert.rejects(failing.start(), /did not become ready|exited while starting/i);
  await failing.stop();
});

type RankingRouter = Pick<RegistryModelRouter, "select" | "host">;

test("MINAI extension runtime starts and stops managed ranking sidecars", async () => {
  let started = 0;
  let stopped = 0;
  const rankingHosts = {
    start: async () => { started += 1; },
    stop: async () => { stopped += 1; },
  } as unknown as LocalRankingHosts;
  const host = { ready: async () => true, invoke: async (input: { model: { id: string } }) => ({ model: input.model, text: "ok" }), async *stream() {} };
  const modelRouter = { select: async () => ({ model: { provider: "p", id: "m" }, source: "fallback", candidates: [] }), host: () => host } as unknown as RankingRouter;
  const runtime = new HttpExtensionRuntime({ port: 0, mode: "local-host", modelRouter: modelRouter as unknown as RegistryModelRouter, rankingHosts });
  await runtime.start();
  assert.equal(started, 1);
  await runtime.stop();
  assert.equal(stopped, 1);
});
