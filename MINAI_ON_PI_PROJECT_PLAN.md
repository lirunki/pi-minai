# MINAI on Pi — Project Plan

Status: planning document  
Repository: local first; intended to become a personal GitHub repository later  
Primary implementation environment: pi.dev / Pi extensions and SDK  
Source system: the Python MINAI repository containing this document

## 1. Mission

Reimplement MINAI as a set of small, independently useful Pi extensions while preserving its important external behavior:

- OpenAI-compatible HTTP API;
- Ollama-compatible HTTP API;
- hierarchical planning and decomposition;
- task-specific guidance;
- per-task model selection, including `model=auto`;
- context passing between task branches;
- plan revision through `NEWPLAN`;
- model hosting and local model use;
- model-created, sandboxed Python tools;
- structured JEV/System One classification for guidance, tool, and model decisions.

Do not port MINAI's current architecture mechanically. Reuse its behavioral requirements and proven data formats where useful, but replace its custom runtime infrastructure with Pi sessions, Pi providers, Pi tools, Pi lifecycle events, and the Pi SDK.

## 2. Non-goals

Unless a later requirement explicitly reintroduces them, do not preserve:

- the current custom Python state machine;
- the global `AgentState` registry and custom UUID lifecycle;
- custom provider clients in orchestration code;
- custom streaming queues;
- the entire MINAI model pool inside the Pi process;
- custom OpenAI/Ollama message classes inside the orchestration core;
- custom tool discovery when Pi's tool registration is sufficient;
- an LLM-generated free-form routing name as the normal selector;
- generated Python imported into the Pi/gateway process;
- a mandatory remote TypeSafe/Jev dependency.

The target is an extension ecosystem, not one monolithic MINAI plugin.

## 3. Source-code orientation

The current Python repository is the behavioral reference.

Important areas:

| Existing area | Use during migration | Intended replacement |
|---|---|---|
| `runtime/agent_graph.py` | planning, decomposition, aggregation, NEWPLAN behavior | orchestration extension and task graph |
| `runtime/agent_state.py` | state fields and lifecycle requirements | explicit task nodes, artifacts, request registry |
| `runtime/statemachine.py` | understand suspension/resume semantics | Pi SDK sessions plus scheduler; do not port wholesale |
| `runtime/guidance_resolution.py` | guidance-resolution compatibility | guidance selector extension using JEV |
| `config/minai_guidance.py` | guidance catalog and model-specific instances | guidance extension |
| `runtime/model_ranking.py` | capability and ranking requirements | `model=auto` extension |
| `hosting/` | local-model lifecycle requirements | model-hosting extension/provider adapters |
| `pool/` | distributed hosting behavior, if still needed | external hoster behind a hoster interface |
| `server/` | API routes and protocol compatibility | OpenAI/Ollama Pi extension |
| `requests_layer/` | normalized request requirements | protocol adapters |
| `tools/` and `skills/tools/` | Python, web, PDF, semantic, and sandbox behavior | independently registered Pi/Python-tool extensions |
| `guidances/*.json` | prompts, roles, and model-specific variants | guidance files/skills/prompts |
| `jev4minai.md` | JEV cascade design and constraints | JEV extension reference |
| `MINAI_JEV_AUDIT.md` | existing selector weaknesses and migration evidence | audit reference, not implementation specification |
| `docs/MINAI_specification.md` | observable API and runtime behavior | compatibility reference |

Existing `graphify-out/` is useful for architectural navigation, but generated graph output is not a runtime dependency of the new system.

## 4. Governing architecture

There are two serving modes over one shared service graph:

```text
Pi interactive session ──> Pi extensions ──┐
                                          ├── shared MINAI services
OpenAI/Ollama HTTP ──────> API extension ──┘
```

The extensions are:

1. **Shared contracts and service registry**
2. **JEV/System One classifier**
3. **Guidance catalog/resolver**
4. **Runtime guidance selector**
5. **Model catalog and model hoster**
6. **`model=auto`**
7. **Context and artifact manager**
8. **Python tools**
9. **Orchestration and sub-agents**
10. **OpenAI/Ollama API**
11. **Observability/request management**

They may initially ship in one npm/Pi package, but each extension must have a narrow service boundary and be usable without the rest wherever possible.

## 5. Shared contracts and service registry

Start with this because all later extensions communicate through it.

Recommended package-level structure:

```text
packages/minai-pi/
├── package.json
├── src/contracts/
├── src/registry/
├── extensions/
└── tests/
```

Shared contracts should include only stable data shapes:

- normalized messages and requests;
- System One/JEV request and answer types;
- guidance definitions and instances;
- model references, capabilities, and catalog records;
- task nodes, plan versions, and graph edges;
- artifact references;
- runtime events;
- provider/hoster interfaces;
- service names and version identifiers.

The service registry should support optional services:

```text
candidate:system-one
catalog:guidance
selector:guidance
catalog:model
hoster:model
selector:model
context:artifacts
runtime:orchestrator
tools:python
```

Do not create a large dependency-injection framework. A small typed registry is sufficient. Missing services must produce explicit capability errors or deterministic fallbacks.

## 6. JEV/System One extension — exact contract

This extension is generic. It must not know what MINAI guidances, models, or tools mean.

It must expose the literal TypeSafe System One shape:

```ts
type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

type ScoreQuestion = {
  type: "score";
  instructions: string;
  levels: string[];
};

type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: {
    true: string;
    false: string;
  };
};

type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

type SystemOneRequest = {
  state: string | Record<string, unknown>;
  model: string;
  questions: Record<string, Question>;
};
```

Answers:

```ts
type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

type NoulAnswer = {
  type: "noul";
  noul: number;
};

type SystemOneResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer | ScoreAnswer | NoulAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};
```

The public operation is conceptually:

```text
systemOne({ state, model, questions }) -> response
```

Do not add MINAI-specific fields such as `selectedId`, `tier`, `ood`, `margin`, `policy`, or `escalated` to the JEV answer objects. Diagnostics may be logged separately.

### JEV backends

The extension must support:

- `remote`: call `https://api.typesafe.ai/v1/systemone` directly;
- `local`: resolve through the local cascade only;
- `auto`: select according to configuration and availability.

The local cascade may use:

1. deterministic shortcuts where appropriate;
2. FlashRank when installed;
3. cached embeddings;
4. a local Jev-compatible/Qwen classifier;
5. a fallback LLM through the model hoster.

Default:

```text
backend = auto
escalate_to_llm = true
```

The local cascade must produce the exact JEV-compatible answer shapes. Validate all output. A malformed fallback LLM response must not be exposed as a successful JEV answer.

The escalation model may be local and served by the model-hosting extension. If no local model is suitable, it may use a configured Pi provider. Prevent recursive escalation: the escalation call must bypass the JEV selection path.

### JEV implementation sequence

1. Implement types and runtime validation.
2. Implement remote TypeSafe HTTP backend.
3. Implement a fake/stub backend for tests.
4. Implement local deterministic fallback sufficient for tests.
5. Add embedding/FlashRank adapters behind interfaces.
6. Add local model-host adapter.
7. Add fallback-LLM adapter with `escalate_to_llm=true` by default.
8. Add Pi service registration and optional inspection command.

## 7. Guidance extension

Port the useful content of `guidances/*.json` into a validated catalog. Keep names such as:

```text
general_qa
code_review
code_analysis
code_authoring
plan_query
plan_docwrite
X_aggregation
```

The extension owns:

- loading guidance files;
- validation and hot reload;
- descriptions, purposes, and tags;
- generic/model-specific prompt instances;
- resolving a prompt instance for `(guidance, model)`.

It should register a guidance catalog service. It should not call a model to select a guidance; that belongs to the runtime guidance selector.

Start with static local JSON/Markdown loading. Add hot reload only after basic resolution is tested.

## 8. Runtime guidance selector extension

This extension uses the guidance catalog and JEV.

It constructs a `ChoiceQuestion` whose criteria map guidance name to guidance description. Its state is assembled from the query and deliberately selected runtime properties, for example:

- user query;
- task query;
- parent role;
- code/attachment/tool indicators;
- context-size class.

JEV receives only `state`, `model`, and `questions`. The selector interprets `ChoiceAnswer.choice` and `probabilities`.

It is used for:

- root requests;
- planner-created tasks without explicit valid guidance;
- NEWPLAN-created tasks;
- optional aggregation routing.

If JEV is unavailable, use explicit guidance first, then deterministic fallback, then generic guidance. Do not reintroduce free-form generated guidance names as the normal path.

## 9. Model catalog and model-hosting extension

The model-hosting extension provides:

- normalized model catalog;
- provider adapters;
- local model process lifecycle;
- readiness and health;
- invocation and streaming;
- abort/release operations;
- optional Pi provider registration.

A model record should describe:

- provider and model ID;
- hoster;
- context window and output limit;
- tool/vision/reasoning/streaming capabilities;
- cost and quality metadata;
- local/remote status;
- ready/cold/offline status.

Support adapters for the environments actually required. Initially prefer:

1. existing Pi providers;
2. Ollama;
3. llama.cpp/local GGUF;
4. remote OpenAI-compatible endpoints.

Do not port `PoolHub` and `PoolNode` into the orchestration process. If distributed hosting remains required, expose the existing pool behind the model-hoster interface.

The hoster answers “how do I make/invoke this model?” It does not answer “which model should the task use?”

## 10. `model=auto` extension

This extension depends on:

- model catalog;
- guidance catalog/selector;
- JEV.

It receives:

- task query;
- resolved guidance or guidance candidates;
- context properties;
- requested model;
- hard capability requirements;
- cost/locality policy.

It first filters impossible models, then creates a JEV Choice question over the eligible models. The selected model is pinned to the task. New tasks after NEWPLAN are selected independently.

If JEV is absent, use deterministic quality/cost/capability ranking. If the requested model is not `auto`, support a policy choosing between strict honoring and routing; default behavior should be documented and tested.

## 11. Context and artifact boundary

Use Pi `AgentSession` as the authoritative session and context owner. Do not create a second MINAI session abstraction or duplicate Pi's context trimming/compaction.

MINAI owns:

- task input envelopes;
- parent/dependency/sibling artifact references;
- artifact storage and access policy;
- selecting which artifact references a task may receive;
- rendering selected task inputs at the Pi session boundary.

Pi owns:

- ordered message history;
- context-window fitting;
- compaction and summarization;
- prompt queueing and session persistence;
- provider payload construction.

A task must receive selected artifact references rather than every prior transcript by default. Artifact resolution may provide a summary, path/reference, or explicitly requested content; Pi decides how the resulting messages fit its context.

Artifacts include:

- request;
- plan;
- task output;
- tool output;
- files/reports;
- summaries;
- errors.

Start with an in-memory request-scoped store and a JSON/JSONL persistence option for debugging. Do not introduce a database before the graph and artifact contracts stabilize.

## 12. Python tools extension

This is an independently useful extension.

Pi-facing operations:

```text
list_python_tools(search?)
create_python_tool(definition)
run_python_tool(name, args)
```

The tool workspace should have active, draft, disabled, and run-history areas. Each tool has a manifest containing:

- name;
- description/purpose/tags;
- input JSON schema;
- entrypoint;
- permissions;
- version/status.

`list_python_tools` with a search sentence uses the JEV extension. Use a Choice question for one best tool or multiple Nouls for independent suitability. The Python extension applies thresholds; JEV only returns literal answers.

Generated Python must execute in a separate process or sandbox. Never import model-generated tool source into Pi or the gateway. Enforce filesystem, network, subprocess, timeout, memory, output, and dependency policy.

Python results may publish artifacts or request NEWPLAN through a structured result understood by orchestration.

## 13. Orchestration extension

This is the main MINAI behavior extension, but it must remain a coordinator rather than absorbing the other extensions.

It owns:

- direct-vs-planned execution;
- planner/decomposer;
- task graph and plan versions;
- scheduler and concurrency;
- Pi SDK sub-agent sessions;
- context edge requests;
- task retries/cancellation;
- NEWPLAN;
- aggregation.

A task node contains:

- ID and plan version;
- parent and dependency IDs;
- query and task type;
- selected guidance/model;
- model policy;
- context/artifact references;
- status;
- retry and NEWPLAN metadata.

### Planning

The planner decides direct or decomposed execution. The decomposer validates and materializes the graph. Planner output must be schema-validated. Do not make every request pay for a planner; support direct execution and use JEV Noul/Score questions or explicit runtime policy to decide when planning is necessary.

### Sub-agents

Each independent subtask can run in a separate Pi SDK session. The session receives:

- selected model;
- resolved guidance instance;
- system/task prompt;
- selected context artifacts;
- allowed tools;
- task limits.

Independent tasks can run concurrently subject to a scheduler limit.

### NEWPLAN

Implement NEWPLAN as a structured control event/tool, not as a text marker. A NEWPLAN request contains:

- reason;
- discovered facts;
- unresolved questions;
- obsolete task IDs;
- preserved artifact IDs;
- optional proposed tasks.

The runtime preserves completed artifacts, cancels or marks obsolete work, creates a new plan version, re-runs guidance and model selection for new tasks, and resumes execution.

## 14. OpenAI/Ollama API extension

This is a Pi extension, not a separate orchestration implementation. It must use Pi sessions for execution and maintain a request registry for HTTP-owned sessions.

It owns:

- HTTP listener lifecycle;
- OpenAI Chat Completions;
- OpenAI Responses if required;
- Ollama `/api/chat`;
- Ollama `/api/generate`;
- request normalization;
- streaming formatting;
- authentication;
- client cancellation;
- health and model endpoints;
- continuation IDs for caller-provided tool results.

Caller-provided tools are bound as Pi fake tools. When Pi calls one, the fake tool pauses on a promise, the API returns the tool call plus a continuation identifier, and a later authenticated request resolves that promise with the caller's tool result. The gateway never executes caller-provided tool code.

Pi remains authoritative for streaming events, token usage when available, thinking-level clamping, and context compaction. MINAI must not implement a competing context trimmer. The API extension maps these capabilities into protocol responses and reports estimates as estimates.

It calls the orchestration service and formats the normalized result. The orchestration core must not contain OpenAI/Ollama response types.

The server should start on `session_start` and close on `session_shutdown` for interactive Pi use. Also provide a standalone gateway entrypoint for persistent/headless service use, backed by the same extension/runtime code.

## 15. Observability and request management extension

Track request-scoped state:

- request ID;
- graph and plan version;
- active Pi sessions;
- cancellation signal;
- timeout;
- stream subscribers;
- runtime events.

Emit events such as:

```text
request_received
plan_created
task_created
guidance_selected
model_selected
tool_selected
task_started
artifact_published
task_completed
newplan_requested
plan_replaced
task_cancelled
aggregation_started
request_completed
```

JEV backend/tier/latency/escalation diagnostics may be logged here, but never added to the literal JEV answer schema.

## 16. Design-first implementation method

The future agent must not jump directly from the architecture description to feature code. Every major capability is designed in four explicit stages:

```text
A. Architecture
   What responsibility exists, and where does it live?

B. Module/extension decomposition
   Which Pi extension, shared module, adapter, or external process owns it?

C. Interface design
   What exact inputs, outputs, lifecycle events, errors, and optional dependencies exist?

D. Implementation design and code
   What is the smallest implementation that satisfies the interface and tests?
```

The order is mandatory. Do not implement a later extension until its place in the architecture, module decomposition, and service interfaces are documented. Do not write shared implementation code until the shared contracts and registry have been reviewed against all intended consumers.

For each phase, create or update a short design note containing:

- responsibility and non-responsibilities;
- dependency direction;
- Pi extension entrypoint and lifecycle hooks;
- service registrations and required/optional dependencies;
- TypeScript interfaces and exact data schemas;
- error, timeout, cancellation, and fallback behavior;
- test seams and acceptance criteria;
- mapping back to the relevant MINAI source behavior.

### Design stage 1 — system architecture

Before coding, document the complete extension ecosystem and the two serving modes:

```text
Pi session → Pi extensions → shared services
HTTP API  → API extension → shared services
```

Document the dependency graph, trust boundaries, process boundaries, data flow, task graph, model flow, JEV flow, Python-tool flow, and NEWPLAN flow. Explicitly identify which current MINAI responsibilities are removed, retained, or moved behind an adapter.

Deliverable: `docs/architecture.md` or an equivalent section in this plan.

### Design stage 2 — module and Pi-extension decomposition

For each extension, document:

- its single primary responsibility;
- what it owns;
- what it must not own;
- services it registers;
- services it consumes;
- Pi commands, tools, events, and SDK surfaces it exposes;
- whether it can run without the other extensions;
- whether it requires a separate process.

Required extensions:

1. shared contracts/service registry;
2. JEV/System One;
3. guidance catalog/resolver;
4. runtime guidance selector;
5. model catalog/hoster;
6. `model=auto`;
7. context/artifacts;
8. Python tools;
9. orchestration/sub-agents;
10. OpenAI/Ollama API;
11. observability/request management.

Deliverable: `docs/extensions.md` or equivalent extension design notes.

### Design stage 3 — interface design

Define and review interfaces before implementation. At minimum, specify:

- literal System One request/response types;
- service registry API;
- guidance catalog and instance resolver;
- model catalog, provider, and hoster contracts;
- model selector contract;
- context/artifact contract;
- task graph, scheduler, and plan-version contracts;
- Python tool manifest, discovery, creation, and runner contracts;
- OpenAI/Ollama normalized request/result contracts;
- runtime events, cancellation, and error types.

Interfaces must preserve the literal TypeSafe/Jev API. Domain extensions may construct and interpret JEV questions, but they must not change the JEV request or answer shape.

Deliverable: `src/contracts/` plus interface documentation and contract tests.

### Design stage 4 — shared-module implementation

Only after the previous stages are complete, implement the shared modules:

- contracts and runtime validators;
- service registry;
- common error/result types;
- event envelopes;
- model/message normalization types;
- test fixtures and fake service implementations.

Shared modules must contain no MINAI-specific orchestration policy and no concrete provider implementation. Every shared module must be usable by at least two planned extensions or be justified as a boundary contract.

Deliverable: compiling shared package with offline tests.

## 17. Implementation order

Implement in small independently testable increments. Each phase below follows the design-first stages above. A phase is not complete when code merely works locally; it is complete when its design note, interface tests, implementation tests, and acceptance criteria are complete.

### Phase 0 — architecture, decomposition, and shared foundation

Architecture/design:

- initialize Git and package metadata;
- document the complete architecture and dependency graph;
- decompose responsibilities into independently loadable Pi extensions;
- document process boundaries for HTTP, local models, and generated Python;
- define extension lifecycle and service-discovery rules.

Interfaces:

- define shared contracts;
- define service registry API;
- define common errors, capability failures, lifecycle events, and cancellation types;
- define fake services for offline tests.

Implementation:

- add TypeScript configuration, test runner, formatter, and linter;
- add `.gitignore` and package README;
- implement contracts, validators, registry, and test fixtures.

Acceptance: the package loads in Pi, the shared package compiles, and no feature extension is required for the shared tests.

### Phase 1 — JEV contract and remote backend

Design:

- verify the literal TypeSafe System One request and response contract from the current documentation;
- specify remote/local/auto backend selection and validation behavior;
- specify how the JEV extension registers with the service registry without exposing backend-specific metadata in answers.

Implementation:

- implement literal request/question/answer types;
- implement runtime validators;
- implement remote TypeSafe endpoint;
- implement stub backend;
- add tests for Choice, Score, Noul, batching, and malformed responses;
- expose a small diagnostic command/tool only if useful.

Acceptance: remote and stub backends return identical validated shapes.

### Phase 2 — guidance catalog and resolver

Design:

- map the current guidance JSON schema to the new catalog and model-specific instances;
- specify reload and invalidation behavior;
- specify which prompts are skills, catalog data, or runtime prompt layers.

Implementation:

- port a small initial catalog: `general_qa`, `code_review`, `code_analysis`, `code_authoring`, `X_aggregation`;
- resolve model-specific prompt instances;
- validate reload behavior;
- add tests.

Acceptance: guidance can be loaded and resolved independently of orchestration.

### Phase 3 — JEV local cascade

Design:

- define backend interfaces for FlashRank, embeddings, local classifier, and hoster-provided LLM fallback;
- define cache keys and invalidation;
- define default `escalate_to_llm=true`, recursion prevention, and typed fallback behavior.

Implementation:

- add backend mode `local` and `auto`;
- implement deterministic fallback;
- add embedding cache interface;
- add FlashRank adapter if available;
- add local classifier adapter through model hoster interface;
- add fallback LLM with default `escalate_to_llm=true`;
- prevent recursion and validate all outputs.

Acceptance: local operation works without a TypeSafe key; auto chooses remote/local as configured.

### Phase 4 — runtime guidance selector

Design:

- define the state text construction policy;
- define the Choice question generated from guidance candidates;
- define interpretation thresholds outside JEV and deterministic fallback behavior.

Implementation:

- build JEV Choice questions from guidance catalog;
- implement root/task selection;
- implement deterministic fallback;
- add confidence policy outside JEV;
- add tests using stub JEV.

Acceptance: guidance selector does not know or depend on the specific JEV backend.

### Phase 5 — model catalog, hoster, and `model=auto`

Design:

- define model catalog and provider/hoster boundaries;
- define hard capability filtering before JEV Choice selection;
- define strict/requested/auto model policy and task pinning;
- define local model readiness and invocation lifecycle.

Implementation:

- implement normalized model catalog;
- wrap existing Pi/Ollama/llama.cpp providers as appropriate;
- implement readiness/invocation interfaces;
- implement hard capability filters;
- implement model Choice through JEV;
- add fallback ranking.

Acceptance: a task can resolve and invoke one concrete model with `model=auto`.

### Phase 6 — context and artifacts

Design:

- define prompt-layer precedence;
- define artifact references and context edges;
- define parent/dependency/sibling propagation;
- define context budgets and trimming behavior.

Implementation:

- implement prompt layers;
- implement artifact store;
- implement task context rendering;
- add context budgeting/trimming;
- add tests for parent/dependency/sibling context.

Acceptance: two tasks can exchange artifact references without copying all transcripts.

### Phase 7 — Python tools

Design:

- define the workspace and manifest schema;
- define JEV Choice/Noul tool selection behavior;
- define runner IPC and sandbox policy;
- define artifact and NEWPLAN result integration.

Implementation:

- implement manifest/workspace;
- implement isolated runner;
- implement `list_python_tools` with optional search;
- integrate JEV Choice/Noul selection;
- implement create/run lifecycle;
- publish artifacts;
- enforce security policy.

Acceptance: a model can discover an existing generated tool and run it safely; no generated code is imported in-process.

### Phase 8 — orchestration and Pi sub-agents

Design:

- define task graph, scheduler, and plan-version interfaces;
- define Pi SDK sub-agent lifecycle;
- define planner/decomposer/aggregator contracts;
- define direct execution versus planned execution.

Implementation:

- implement task graph and plan versions;
- implement direct execution;
- implement planner/decomposer;
- implement scheduler and parallel sub-agents;
- integrate guidance, model=auto, context, and tools;
- implement aggregation.

Acceptance: one request can execute multiple tasks on separate Pi sessions and produce one aggregate answer.

### Phase 9 — NEWPLAN

Design:

- define the structured NEWPLAN control event;
- define preserved artifacts, obsolete tasks, cancellation, and plan-version rules;
- define re-selection of guidance and models for new tasks;
- define loop and depth limits.

Implementation:

- implement structured request_newplan control;
- preserve completed artifacts;
- cancel/obsolete pending tasks;
- create new plan versions;
- reselect guidance/models for new tasks;
- add loop/depth/version limits.

Acceptance: a task can invalidate part of the plan and execution resumes from a new version without rerunning preserved work.

### Phase 10 — OpenAI/Ollama API extension — complete

Design:

- define normalized request/result contracts independent of protocol;
- define OpenAI and Ollama compatibility boundaries;
- define stream, cancellation, auth, error, and lifecycle behavior;
- define interactive Pi-server and standalone gateway modes.

Implementation:

- normalize Chat Completions and Ollama requests;
- implement non-streaming responses;
- implement streaming;
- implement tool-call compatibility;
- add auth, health, model listing, cancellation;
- start/stop with Pi lifecycle and standalone gateway mode.

Acceptance: existing representative OpenAI/Ollama clients can call direct and planned requests.

### Phase 11 — hardening and packaging — complete

Design:

- review cross-extension contracts;
- document optional-dependency degradation;
- define integration, security, and performance acceptance criteria.

Implementation:

- integration tests across all extensions;
- benchmark direct vs planned execution;
- benchmark JEV local/remote paths;
- audit Python sandbox;
- document configuration;
- package as a Pi package;
- prepare GitHub metadata and release workflow.

Completed implementation evidence:

- cross-mode HTTP integration coverage for Pi and local-host execution;
- authenticated metrics and cancellation endpoints;
- owner-bound tool continuations and idempotent cancellation accounting;
- documented configuration, shutdown, loopback-host, and sandbox guidance;
- explicit package files, Node.js engine requirement, and dry-run packaging;
- production TypeScript typecheck and focused HTTP lifecycle validation.

Known follow-up work is operational rather than a Phase 11 blocker: benchmark
results for real model hosts, a production OS sandbox for hostile generated
Python, and a release CI workflow when the package is made public.

## 18. Testing strategy

Each extension must have unit tests with mocked services and no network requirement.

Required test categories:

- contract validation;
- missing optional extension behavior;
- backend failure and timeout;
- request cancellation;
- model unavailability;
- context limits;
- malformed model/tool output;
- NEWPLAN versioning;
- Python permissions;
- API streaming and protocol formatting.

Use recorded fixtures for remote TypeSafe/Jev responses. Do not require a TypeSafe API key in ordinary tests.

Use the existing MINAI benchmark fixtures later for end-to-end routing and quality comparisons. Keep benchmarks outside the runtime package.

## 19. Configuration principles

Use one project configuration file, but keep extension namespaces separate:

```jsonc
{
  "jev": {
    "backend": "auto",
    "escalate_to_llm": true,
    "remote": { "model": "jev-latest" },
    "local": { "model": "qwen3-0.8b" }
  },
  "guidance": {},
  "model_hosting": {},
  "model_auto": {},
  "python_tools": {},
  "orchestration": {},
  "api": {}
}
```

Defaults must be safe and explicit. Do not hide policy in prompt strings or magic constants.

## 20. Security constraints

- Pi extensions are trusted code and run with host permissions.
- Model-generated Python is not trusted code.
- Generated Python must run out-of-process or in a real sandbox.
- Default Python permissions: project-read and artifact-write only.
- Network and subprocess access require explicit policy.
- Do not expose secrets through task context or tool output.
- Do not let escalation recursively invoke JEV selection.
- Validate every closed-set selection against the supplied candidates.
- Limit plan depth, plan versions, task count, concurrency, runtime, and output size.

## 21. Acceptance criteria for the complete system

The project is complete enough for an initial release when:

1. Pi can load the extensions independently.
2. JEV can call the real TypeSafe endpoint or resolve locally through the cascade.
3. JEV always returns literal Choice/Score/Noul-compatible answers.
4. Guidance selection uses JEV but does not implement its own classifier.
5. `model=auto` uses JEV plus model capability filtering.
6. Python tools can be searched with a sentence, created, and run in isolation.
7. Orchestration can create and execute a task graph using Pi sub-agents.
8. Context passes through explicit artifacts and edges.
9. NEWPLAN creates a new plan version and preserves completed work.
10. OpenAI and Ollama requests can execute direct and planned runs.
11. Model hosting is replaceable behind a hoster interface.
12. Individual extensions degrade gracefully when optional dependencies are absent.
13. Tests run offline except for explicitly marked integration tests.
14. The package can be installed as a Pi package and later published to personal GitHub/npm.

## 22. Future GitHub preparation

The local repository should eventually be publishable without restructuring.

Before the first public push:

- remove local secrets and endpoint files;
- verify `.gitignore` excludes caches, model files, tool runs, and credentials;
- add LICENSE selected by the owner;
- add CONTRIBUTING.md only if needed;
- add SECURITY.md describing generated-code risks;
- add architecture and configuration docs;
- add CI for tests/typecheck/lint;
- pin supported Pi SDK versions;
- separate optional dependencies for FlashRank, embeddings, local model backends, and sandboxing;
- document remote TypeSafe API requirements and privacy behavior;
- review all generated artifacts before committing.

## 23. Instructions to the future implementation agent

Work one phase at a time. Before implementing a phase:

1. inspect the relevant current MINAI files;
2. inspect the current Pi extension/SDK documentation;
3. state the exact compatibility behavior being preserved;
4. implement the smallest independently testable slice;
5. add tests before moving to the next extension;
6. run typecheck/tests;
7. update this plan with decisions and deviations;
8. commit the phase separately.

Do not start by porting `minai.py`, `runtime/agent_graph.py`, or `server/endpoint_layer.py` wholesale. Start with contracts and the smallest extension. Do not introduce a dependency between extensions merely because the current Python code has a global import path. Use service contracts and explicit registration.

When a requirement is ambiguous, preserve the literal external API first and ask before changing semantics. In particular, never alter the JEV System One request/response shape for MINAI convenience.
