# Stage 6 design — Pi-native sessions and explicit task context

## Decision

MINAI will **not** implement context trimming, token budgeting, transcript compaction, or a second session abstraction. Those are Pi responsibilities.

Pi's `AgentSession` is the session and context owner:

- `session.messages` / `session.agent.state.messages` hold conversation history;
- `session.prompt()` appends work to that session;
- Pi owns queueing, retries, compaction, and auto-compaction;
- Pi's `context` event is available for observation or narrow, deliberate message adaptation;
- Pi's `before_agent_start` event can inject the task envelope for a run;
- `session.compact()` and Pi's compaction lifecycle remain authoritative.

MINAI owns only the **task input envelope** and the selection of explicitly requested artifacts before calling Pi. It must not recreate Pi's context window logic.

## Two context meanings

These terms must remain distinct:

1. **Pi session context** — the authoritative ordered message history sent through Pi's agent loop.
2. **MINAI task inputs** — the task query, selected guidance instance, selected model, and explicit artifact references used to start or continue a Pi session.

MINAI task inputs become Pi messages or system-prompt additions at the session boundary. After that, Pi owns how they coexist with history and compaction.

## Ownership map

| Concern | Owner |
|---|---|
| Session identity and persistence | Pi `AgentSession` / `SessionManager` |
| Conversation history | Pi |
| Context-window fitting and compaction | Pi |
| Prompt queueing, steering, follow-ups | Pi `prompt`, `steer`, `followUp` |
| Current model and thinking level | Pi session, coordinated with MINAI selection |
| Task graph and task IDs | MINAI orchestration |
| Guidance selection and prompt instance | MINAI guidance extensions |
| Artifact storage and access policy | MINAI artifact service, later stage |
| Which artifacts a task may receive | MINAI orchestration/task node |
| Rendering the task envelope | MINAI/Pi adapter |
| Provider payload serialization | Pi/provider extensions |

## Task envelope

The first execution slice should pass a structured, deterministic envelope to Pi:

```ts
type PiTaskEnvelope = {
  requestId: string;
  taskId: string;
  planVersion?: number;
  query: string;
  guidanceId?: string;
  guidanceInstructions?: string;
  artifactInputs: Array<{
    id: string;
    kind: string;
    label?: string;
    content: string;
  }>;
  outputContract?: string;
};
```

The envelope is not a replacement for Pi messages and is not persisted in a parallel transcript. The adapter renders it as a clearly delimited task instruction/custom message when a task starts. Sensitive or large artifact bodies should be resolved only when the task is authorized to receive them.

## Pi integration modes

### Interactive Pi mode

The MINAI extension attaches to the active Pi lifecycle:

```text
user input
  → before_agent_start
  → guidance/model selection
  → render task envelope
  → Pi agent loop
  → Pi tools and native context
```

The extension may use `before_agent_start` to add the selected guidance/task envelope. It should not replace the complete system prompt or rewrite the full message history by default. Existing user system prompts, skills, tool snippets, and context files remain Pi-managed.

### Programmatic/sub-agent mode

Orchestration creates a separate Pi `AgentSession` for an independent task using the SDK's `createAgentSession()` and an appropriate `SessionManager` (request-scoped or persistent according to the caller). It supplies:

- the pinned Pi model;
- the registered Pi tools;
- the task envelope as the initial prompt;
- session-scoped extension bindings;
- the task's cancellation signal.

A sub-agent is a Pi session, not a MINAI context object. Its messages, compaction, events, and disposal are handled through the Pi SDK.

### HTTP mode

The API adapter normalizes an HTTP request into a root task, then obtains or creates a Pi session according to the HTTP session policy. It calls the same task-envelope/session adapter used by interactive mode and formats Pi events into the protocol stream. It must not construct an independent message-history or trimming path.

## Extension hooks and constraints

- `before_agent_start`: use for task-envelope injection and per-run guidance instructions.
- `context`: observe Pi's outgoing message context; only modify it for an explicit compatibility feature approved later. Never trim here in Stage 6.
- `message_*`, `turn_*`, and `agent_*`: observe execution and publish MINAI runtime events/artifacts.
- `tool_execution_*`: observe Pi-native tool results and associate them with the current task.
- `session_start` / `session_shutdown`: attach and release request-scoped MINAI services; do not start resources in the extension factory.
- `session_compact` and compaction events: observe/report only. Do not run a competing compactor.

## Artifact strategy

Artifacts are not automatically copied into every session. Orchestration selects artifact references per task. A future artifact service resolves an authorized reference into a bounded-by-policy payload for the envelope, while Pi remains responsible for fitting that payload into its context and compacting later history.

A task may receive:

- a short artifact summary;
- a file path or URI plus a Pi/tool instruction to read it;
- full content when explicitly selected and appropriate.

The artifact service must not silently inject all parent transcripts.

## Model coordination

MINAI's `model=auto` returns a provider/id reference. The Pi adapter resolves that reference through Pi's `ModelRuntime`/model APIs and creates or updates the Pi session with the resolved Pi model. MINAI's catalog is a normalized routing view; Pi remains the provider/model execution authority.

If Pi cannot resolve the selected model, the adapter returns a typed capability error rather than silently choosing a different model. A later routing policy may explicitly permit retry selection.

## Cancellation and lifecycle

The caller owns an `AbortSignal`. The adapter propagates cancellation to:

- JEV selection;
- artifact resolution;
- `session.prompt()` orchestration;
- `session.abort()` for an active Pi run;
- sub-agent disposal.

Pi session disposal is mandatory for request-scoped sub-agents. The active interactive session must not be disposed by a task extension.

## Deliberate non-goals

Stage 6 does not implement:

- context trimming;
- token counting or context budgets;
- custom summarization;
- replacement of Pi compaction;
- a MINAI transcript database;
- automatic copying of sibling/parent history;
- direct provider payload rewriting;
- a second model invocation loop around Pi.

## First vertical slice acceptance

The next implementation should prove only this:

1. create/select a Pi session;
2. resolve guidance and model outside the session;
3. render one task envelope;
4. submit it through Pi's SDK/session API;
5. observe native Pi events and associate them with the task;
6. let Pi own history and compaction;
7. dispose only sessions created for the task.
