import assert from "node:assert/strict";
import test from "node:test";
import { PiTaskError, PiTaskRunner, renderPiTaskEnvelope } from "../src/index.js";
import type { PiSessionLike } from "../src/index.js";

const envelope = {
  requestId: "req-1",
  taskId: "task-1",
  planVersion: 2,
  query: "Review the implementation.",
  guidanceId: "code_review",
  guidanceInstructions: "Identify defects and improvements.",
  artifactInputs: [{ id: "a-1", kind: "file", label: "source", content: "const answer = 42;" }],
  outputContract: "Return findings with severity.",
};

test("renders a deterministic task envelope without trimming session context", () => {
  const rendered = renderPiTaskEnvelope(envelope);
  assert.match(rendered, /task_id: task-1/);
  assert.match(rendered, /## Guidance/);
  assert.match(rendered, /artifact_id: a-1/);
  assert.match(rendered, /## Output contract/);
});

test("runs a task session, captures Pi events, and disposes owned session", async () => {
  let session!: FakeSession;
  const events: string[] = [];
  const runner = new PiTaskRunner(async () => {
    session = new FakeSession();
    return session;
  });
  const result = await runner.run(envelope, { provider: "pi", id: "model" }, undefined, ({ event }) => events.push(event.type));
  assert.equal(result.text, "final answer");
  assert.deepEqual(events, ["agent_start", "message_update", "agent_end"]);
  assert.equal(session.promptText.includes("Review the implementation."), true);
  assert.equal(session.disposed, true);
});

test("aborts before creating a session", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const runner = new PiTaskRunner(async () => { called = true; return new FakeSession(); });
  await assert.rejects(() => runner.run(envelope, { provider: "pi", id: "model" }, controller.signal), (error: unknown) => error instanceof PiTaskError && error.code === "pi_task_aborted");
  assert.equal(called, false);
});

test("aborts active session and disposes it", async () => {
  let session!: FakeSession;
  const controller = new AbortController();
  const runner = new PiTaskRunner(async () => { session = new FakeSession(true); return session; });
  const run = runner.run(envelope, { provider: "pi", id: "model" }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(run, (error: unknown) => error instanceof PiTaskError && error.code === "pi_task_aborted");
  assert.equal(session.aborted, true);
  assert.equal(session.disposed, true);
});

class FakeSession implements PiSessionLike {
  private listener?: (event: { type: string; [key: string]: unknown }) => void;
  promptText = "";
  disposed = false;
  aborted = false;
  constructor(private readonly blocking = false) {}
  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async prompt(text: string): Promise<void> {
    this.promptText = text;
    this.listener?.({ type: "agent_start" });
    if (this.blocking) { await new Promise((resolve) => setTimeout(resolve, 30)); return; }
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "final answer" } });
    this.listener?.({ type: "agent_end" });
  }
  async abort(): Promise<void> { this.aborted = true; }
  dispose(): void { this.disposed = true; }
}
