import assert from "node:assert/strict";
import test from "node:test";
import { createPiHttpExecutionServices, createPiSdkRequestSessionFactory } from "../src/index.js";
import type { PiSessionLike } from "../src/index.js";

function session(text: string): PiSessionLike { let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined; return { prompt: async () => { listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }); }, subscribe: (next) => { listener = next; return () => { listener = undefined; }; }, abort: async () => {}, dispose: () => {} }; }

test("caller tools flow through HTTP continuation into Pi custom tools", async () => {
  const creator = createPiSdkRequestSessionFactory({ modelReference: { provider: "p", id: "m" }, resolveModel: async () => ({ provider: "p", id: "m" } as never) }, async (options) => {
    const tool = options.customTools?.[0];
    let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    return { session: {
      async prompt() {
        assert.ok(tool, "caller tool should be registered in the Pi session");
        const result = await tool.execute("pi-tool-call-1", { q: "lookup" }, undefined, undefined, {} as never);
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      },
      subscribe(next) { listener = next; return () => { listener = undefined; }; },
      abort: async () => {},
      dispose: () => {},
    } as PiSessionLike };
  });
  const services = createPiHttpExecutionServices({ createSession: creator });
  const request = { protocol: "openai" as const, requestId: "caller-tools", model: { provider: "p", id: "m" }, messages: [{ role: "user" as const, content: "use lookup" }], tools: [{ name: "lookup", description: "Look up data", parameters: { type: "object", properties: { q: { type: "string" } } } }], stream: true };
  const first = services.continuation!.start(request);
  const pause = await first.next();
  assert.equal(pause.value?.type, "tool_pause_batch");
  if (pause.value?.type !== "tool_pause_batch") return;
  assert.equal(pause.value.calls[0]?.name, "lookup");
  const resumed = services.continuation!.resumeBatch({ [pause.value.calls[0]!.continuationId]: { found: true } });
  const events = [];
  for await (const event of resumed) events.push(event);
  assert.ok(events.some((event) => event.type === "text_delta" && event.delta === '{"found":true}'));
  assert.equal(events.at(-1)?.type, "done");
});

test("HTTP execution services use request-owned sessions", async () => {
  const ids: string[] = [];
  const services = createPiHttpExecutionServices({ createSession: async ({ id }) => { ids.push(id); return session("ok"); } });
  const result = await services.complete({ protocol: "openai", requestId: "req-1", model: { provider: "p", id: "m" }, messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(result.text, "ok");
  assert.equal(ids.length, 1);
});

test("HTTP execution services stream through the Pi adapter", async () => {
  const services = createPiHttpExecutionServices({ createSession: async () => session("stream") });
  const events = [];
  for await (const event of services.stream({ protocol: "openai", requestId: "req-2", model: { provider: "p", id: "m" }, messages: [{ role: "user", content: "hi" }], stream: true })) events.push(event);
  assert.equal(events[0]!.type, "text_delta");
  assert.equal(events.at(-1)!.type, "done");
});
