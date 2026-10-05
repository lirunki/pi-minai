import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpExtensionRuntime } from "../extensions/http.js";

const document = { hosts: { py: { backend: "python-minai", baseUrl: "http://127.0.0.1:9100" } }, models: [{ provider: "python-minai", id: "m", host: "py", locality: "local", availability: "ready", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: false, vision: false, reasoning: false, streaming: true } }] };
test("HTTP runtime loads local model hosts from registryPath", async () => { const directory = await mkdtemp(join(tmpdir(), "minai-http-registry-")); const path = join(directory, "hosts.json"); await writeFile(path, JSON.stringify(document)); const runtime = new HttpExtensionRuntime({ port: 0, mode: "local-host", registryPath: path, refreshHostHealth: false, maxConcurrentPerHost: 1 }); const server = await runtime.start(); await server.close(); });
