import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileModelHostRegistry, LocalHostRuntime } from "../src/index.js";

const document = { hosts: { py: { backend: "python-minai", baseUrl: "http://127.0.0.1:9100" } }, models: [{ provider: "python-minai", id: "m", host: "py", locality: "local", availability: "ready", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: false, vision: false, reasoning: false, streaming: true } }] };
test("local host runtime builds bounded host facade and refreshes health", async () => { const directory = await mkdtemp(join(tmpdir(), "minai-runtime-")); const path = join(directory, "hosts.json"); await writeFile(path, JSON.stringify(document)); const registry = await FileModelHostRegistry.load(path); const runtime = new LocalHostRuntime(registry, { maxConcurrentPerHost: 1 }); const health = await runtime.refreshHealth(); assert.ok(["unavailable", "failed"].includes(health.get("py")?.state ?? "")); assert.ok(runtime.host({ provider: "python-minai", id: "m" })); });
