import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryModelHost, ModelUnavailableError, StaticModelCatalog } from "../src/index.js";
import type { AvailableModel, ModelInvocation } from "../src/index.js";

const models: AvailableModel[] = [
  { provider: "local", id: "fast", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: false, vision: false, reasoning: false, streaming: true }, locality: "local", availability: "ready", quality: 0.7 },
  { provider: "remote", id: "vision", contextWindow: 8192, maxOutputTokens: 1024, capabilities: { tools: true, vision: true, reasoning: true, streaming: false }, locality: "remote", availability: "ready", quality: 0.9 },
  { provider: "local", id: "offline", contextWindow: 4096, maxOutputTokens: 512, capabilities: { tools: true, vision: false, reasoning: false, streaming: false }, locality: "local", availability: "offline" },
];

const invocation: ModelInvocation = { model: { provider: "local", id: "fast" }, messages: [{ role: "user", content: "hello" }] };

test("catalog validates, clones, and filters hard capabilities", () => {
  const catalog = new StaticModelCatalog(models);
  assert.equal(catalog.filter({ tools: true, vision: true }).length, 1);
  assert.equal(catalog.filter({ locality: "local" }).length, 2);
  const copy = catalog.get({ provider: "local", id: "fast" })!;
  copy.capabilities.tools = true;
  assert.equal(catalog.get({ provider: "local", id: "fast" })!.capabilities.tools, false);
  assert.throws(() => new StaticModelCatalog([{ ...models[0]!, id: "" }]), /non-empty/);
  assert.throws(() => new StaticModelCatalog([{ ...models[0]!, description: " " }]), /invalid description/);
});

test("in-memory host invokes ready models and provides fallback streaming", async () => {
  const catalog = new StaticModelCatalog(models);
  const host = new InMemoryModelHost(catalog, async (input) => ({ model: input.model, text: "hello", finishReason: "stop" }));
  assert.equal(await host.ready(invocation.model), true);
  const result = await host.invoke(invocation);
  assert.equal(result.text, "hello");
  const events = [];
  for await (const event of host.stream(invocation)) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["delta", "done"]);
});

test("host rejects unknown and unavailable models", async () => {
  const catalog = new StaticModelCatalog(models);
  const host = new InMemoryModelHost(catalog, async (input) => ({ model: input.model, text: "x" }));
  await assert.rejects(() => host.invoke({ ...invocation, model: { provider: "x", id: "missing" } }), (error: unknown) => error instanceof ModelUnavailableError && error.code === "model_unavailable");
  await assert.rejects(() => host.invoke({ ...invocation, model: { provider: "local", id: "offline" } }), /offline/);
});

test("host forwards abort signal to the injected invoker", async () => {
  const catalog = new StaticModelCatalog(models);
  let received: AbortSignal | undefined;
  const host = new InMemoryModelHost(catalog, async (_input, signal) => { received = signal; return { model: invocation.model, text: "x" }; });
  const controller = new AbortController();
  await host.invoke(invocation, controller.signal);
  assert.equal(received, controller.signal);
});
