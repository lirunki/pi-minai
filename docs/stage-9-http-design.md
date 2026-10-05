# Stage 9 design — OpenAI/Ollama HTTP adapter

This is a design-only stage. The HTTP server must be implemented only after the continuation, streaming, usage, and Pi capability boundaries below are accepted.

## Responsibility

The API extension is a protocol adapter over the shared MINAI services and Pi sessions:

```text
OpenAI/Ollama request
  → normalize
  → guidance/model/orchestration services
  → Pi AgentSession
  → normalize Pi events/results
  → OpenAI/Ollama response
```

It does not implement a second agent loop, provider client, context manager, planner, or tool executor.

## Session and request registry

HTTP requests need a request-scoped registry:

```ts
type HttpRun = {
  requestId: string;
  sessionId: string;
  session: AgentSession;
  owner: "http";
  model: ModelReference;
  thinkingLevel: string;
  pendingTools: Map<string, PendingExternalTool>;
  status: "running" | "paused_for_tools" | "completed" | "failed" | "cancelled";
  expiresAt: number;
  usage: UsageSnapshot;
};
```

A client-provided conversation/session identifier can select a retained Pi session, but it cannot select an arbitrary process session. Continuation IDs are cryptographically random, bound to the run and expected tool call, single-use, and expire. The registry is process-local initially; a later gateway can move it behind a durable coordinator.

## Caller-provided tool binding

### Request

OpenAI function tools and Ollama tools are normalized into a `ToolDefinition`. MINAI registers a same-name Pi custom/fake tool for the HTTP-owned session. The fake tool is not the caller's implementation.

The fake tool's `execute` does this:

1. records tool name, call ID, arguments, and run ID;
2. creates a one-time continuation ID;
3. publishes a `tool_pause` event to the HTTP response coordinator;
4. awaits a resolver promise;
5. when the matching client result arrives, returns that result as the Pi tool result;
6. rejects on expiry, cancellation, or invalid continuation.

The promise is intentionally allowed to outlive the HTTP response. The Pi turn remains suspended inside the fake tool while the HTTP request returns the assistant tool call to the client.

The original caller tool is never executed by MINAI. The caller executes it and sends the result back.

### Multiple tool calls

Pi may issue parallel tool calls. The adapter must collect the complete assistant tool-call batch before returning a paused response. Each call gets a distinct continuation, but the continuation response must identify the run and all unresolved calls. Resume is accepted only when the required batch results are present; partial results remain pending without starting a second Pi prompt.

Duplicate, unknown, wrong-run, wrong-tool, expired, or already-consumed continuation IDs are rejected. Arguments are informational output from Pi; the client result is accepted only for the exact expected call ID/name.

### Continuation request

The compatibility-preserving path accepts standard tool-result messages:

```text
OpenAI: role=tool, tool_call_id=<call id>, content=<result>
Ollama: normalized tool result with matching call id
```

The API adapter extracts and validates these against the paused run. It must not replay the whole client-supplied transcript into Pi. It resolves the fake tool promise, then Pi continues the same session. A non-standard `continuation_id` field/header may be supported as an optimization, but the server must bind it to the expected tool call and never trust it alone.

If a client loses the continuation ID, the run can be recovered only through an authenticated session/run lookup; guessing a tool call ID is not sufficient.

## Streaming

The adapter subscribes to the Pi session before calling `prompt()`.

### Text and thinking

- Pi `message_update` text deltas become OpenAI `chat.completion.chunk` deltas or Ollama streaming objects.
- Pi thinking deltas are not exposed as ordinary assistant text. They map to the selected protocol's reasoning/thinking field only when that protocol/provider contract supports it and the caller requested it.
- Tool-call deltas are emitted as soon as safely correlated, but the final tool-call batch is authoritative.
- Every stream has a terminal finish event and protocol terminator.

### Pause behavior

When the tool batch is ready:

1. emit the assistant tool calls;
2. emit a tool-call finish reason;
3. emit a continuation identifier in an extension field/header/event;
4. terminate this HTTP stream normally.

The Pi session is **not** disposed. It remains `paused_for_tools` in the registry. A continuation request starts a new response stream from the same Pi session after resolving tool promises.

For non-streaming responses, return the assistant tool calls and continuation metadata as a normal response; do not hold the HTTP connection open waiting for an external tool.

### Disconnects

- Disconnect before tool pause: abort the Pi run and dispose an HTTP-owned session unless an explicit retain policy applies.
- Disconnect after a tool pause response: retain the paused run until TTL expiry because the client has a continuation to submit.
- Disconnect during continuation execution: abort the active Pi turn; do not resolve tool promises with fabricated output.

Use bounded queues and backpressure. Never buffer an unbounded assistant stream in memory.

## Token usage

Pi is the source of truth. The adapter maps finalized Pi assistant message usage and session totals into:

```ts
{ prompt_tokens, completion_tokens, total_tokens }
```

Provider-specific cache and reasoning fields are preserved in an internal usage record and exposed only through protocol fields that have a defined compatibility meaning. If Pi/provider usage is unavailable, report `null`/omitted usage or an explicitly marked estimate; never present a character-count estimate as exact token usage.

For streaming, usage is emitted in the final usage chunk only when requested/supported. Tool turns accumulate across the same HTTP run; a continuation response reports the delta for that response and may include a cumulative extension field.

## Effort, thinking, and temperature

Normalize request controls separately:

```ts
type ReasoningRequest = {
  effort?: "none" | "low" | "medium" | "high";
  think?: boolean | "low" | "medium" | "high";
};
```

Mapping:

- OpenAI `reasoning_effort`: `none → off`, `low → low`, `medium → medium`, `high → high`.
- Ollama `think`: `false → off`, `true → configured default`, string levels map directly where supported.
- Pi clamps thinking to model capability; the response/diagnostic records the effective level.
- `temperature` is passed through only when the selected Pi provider supports it.

No request may claim a reasoning level Pi did not apply. The adapter observes `thinking_level_select`/session state and reports the effective value internally.

## Maximum output and context limits

`max_tokens`/`max_completion_tokens` maps to the provider request's maximum output field where Pi exposes that control. If the Pi SDK/provider does not expose a portable setter, the API extension uses a request-scoped `before_provider_request` adapter; it must not mutate unrelated requests.

Context limits are not trimmed by MINAI. Before execution:

1. resolve the selected Pi model's context window;
2. obtain Pi's `ctx.getContextUsage()` where available;
3. reject impossible explicit limits with a compatibility error or let Pi's documented compaction path handle the request according to policy;
4. never manually delete messages in the API adapter.

If auto-compaction occurs, stream the Pi lifecycle as an internal event and continue normal output. If compaction fails, return a typed provider/context error. The API layer reports the effective model/context diagnostics separately from the protocol's normal answer.

## Protocol normalization

One normalized request/result model feeds:

- OpenAI Chat Completions;
- OpenAI Responses if required;
- Ollama `/api/chat`;
- Ollama `/api/generate`.

The orchestration and Pi layers never import OpenAI/Ollama response classes. Protocol-specific details remain in the adapter.

## Security

- authenticate before session/continuation lookup;
- bind continuation to authenticated principal, run, session, and tool call;
- enforce TTL and maximum paused runs;
- cap request body, tool-result, stream, and output sizes;
- never execute caller-provided tools in the gateway;
- do not accept arbitrary session IDs or model/provider payloads;
- cancel and dispose on expiry.

## Implementation slices

1. normalized non-stream text request/result with Pi fake session tests;
2. SSE text streaming and usage mapping;
3. fake-tool pause/continuation state machine with one tool call;
4. multiple parallel tool calls and continuation validation;
5. thinking/effort and max-output provider hooks;
6. OpenAI routes;
7. Ollama routes;
8. disconnect, TTL, auth, and operational limits.

## Compatibility reference: existing Python MINAI

The existing implementation confirms two important behaviors that this design retains:

- pending tool state is keyed by the provider/client `tool_call_id`, and a later tool message resumes the original agent state rather than replaying a fresh request;
- a streaming disconnect abandons ordinary active work, while a deliberately suspended tool state can remain resumable.

The Pi implementation replaces the Python `SuspendState`/global pending-state registry with a request-scoped continuation registry and a Promise held by a Pi fake tool. It keeps the observable tool-call/result protocol while avoiding global mutable agent state and avoiding execution of caller-provided tool code.
