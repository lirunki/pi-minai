import assert from "node:assert/strict";
import test from "node:test";
import { createPiSdkRequestSessionFactory } from "../src/index.js";
import type { PiSessionLike } from "../src/index.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

function session(): PiSessionLike { return { prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose: () => {} }; }

test("SDK request factory creates a fresh session with resolved model and request tools", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const factory = createPiSdkRequestSessionFactory({ modelReference: { provider: "p", id: "m" }, resolveModel: async () => ({ provider: "p", id: "m" } as never), noTools: "all", customTools: ({ requestId }) => [{ name: `tool-${requestId}`, label: "tool", description: "test", parameters: { type: "object" }, execute: async () => ({ content: [], details: undefined }) } as never] }, async (options) => { calls.push(options as Record<string, unknown>); return { session: session() }; });
  const created = await factory({ id: "request-1", signal: new AbortController().signal });
  assert.ok(created);
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.model as { id: string }).id, "m");
  assert.equal((calls[0]!.customTools as unknown[]).length, 1);
});

test("SDK request factory adapts caller tool schemas and handlers into Pi custom tools", async () => {
  let received: Record<string, unknown> | undefined;
  const handlerCalls: Array<{ toolCallId: string; name: string; arguments: unknown }> = [];
  const toolDefinitions = [{ name: "lookup", description: "Look up an item", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }];
  const factory = createPiSdkRequestSessionFactory({ modelReference: { provider: "p", id: "m" }, resolveModel: async () => ({ provider: "p", id: "m" } as never) }, async (options) => { received = options as Record<string, unknown>; return { session: session() }; });
  await factory({
    id: "caller-tools",
    signal: new AbortController().signal,
    externalToolDefinitions: toolDefinitions,
    externalTools: { lookup: async (call) => { handlerCalls.push(call); return { found: true, query: call.arguments }; } },
  });
  const tools = received?.customTools as ToolDefinition[] | undefined;
  assert.equal(tools?.length, 1);
  const lookup = tools![0]!;
  assert.equal(lookup.name, "lookup");
  assert.equal(lookup.description, "Look up an item");
  assert.equal((lookup.parameters as Record<string, unknown>).type, "object");
  const result = await lookup.execute("call-1", { q: "pi" }, undefined, undefined, {} as never);
  assert.deepEqual(handlerCalls, [{ toolCallId: "call-1", name: "lookup", arguments: { q: "pi" } }]);
  assert.deepEqual(result.content, [{ type: "text", text: '{"found":true,"query":{"q":"pi"}}' }]);
  assert.deepEqual(result.details, { found: true, query: { q: "pi" } });
});

test("SDK request sessions use an isolated in-memory session manager", async () => {
  let received: Record<string, unknown> | undefined;
  const factory = createPiSdkRequestSessionFactory({ modelReference: { provider: "p", id: "m" }, resolveModel: async () => ({ provider: "p", id: "m" } as never), cwd: "/tmp/project" }, async (options) => { received = options as Record<string, unknown>; return { session: session() }; });
  await factory({ id: "isolated", signal: new AbortController().signal });
  assert.ok(received?.sessionManager);
  assert.notEqual(received?.sessionManager, undefined);
});

test("SDK request factory rejects already-aborted requests", async () => {
  const controller = new AbortController(); controller.abort();
  const factory = createPiSdkRequestSessionFactory({ modelReference: { provider: "p", id: "m" }, resolveModel: async () => ({ provider: "p", id: "m" } as never) }, async () => ({ session: session() }));
  await assert.rejects(factory({ id: "r", signal: controller.signal }), /aborted/);
});

test("SDK request factory clamps model maxTokens to the requested output cap", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const factory = createPiSdkRequestSessionFactory({ modelReference: { provider: "p", id: "m" }, resolveModel: async () => ({ provider: "p", id: "m", maxTokens: 4096 } as never) }, async (options) => { calls.push(options as Record<string, unknown>); return { session: session() }; });
  await factory({ id: "capped", signal: new AbortController().signal, maxOutputTokens: 1024 });
  assert.equal((calls[0]!.model as { maxTokens: number }).maxTokens, 1024);
  await factory({ id: "uncapped", signal: new AbortController().signal });
  assert.equal((calls[1]!.model as { maxTokens: number }).maxTokens, 4096);
  await factory({ id: "above", signal: new AbortController().signal, maxOutputTokens: 99999 });
  assert.equal((calls[2]!.model as { maxTokens: number }).maxTokens, 4096);
});
