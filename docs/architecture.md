# MINAI on Pi — Stage 0 architecture

This document is the first implementation design artifact for the new system. It describes ownership and dependency direction; it does not implement the runtime.

## Serving modes

```text
Pi interactive session ──> Pi extensions ──┐
                                          ├── shared MINAI services
OpenAI/Ollama HTTP ──────> API extension ──┘
```

The HTTP extension and the Pi-facing extensions must call the same orchestration and service interfaces. There must not be separate planning, routing, or model-selection implementations for the two serving modes.

## Planes

- Serving: OpenAI/Ollama protocol translation, auth, streaming, cancellation.
- Orchestration: plans, task graph, scheduler, sub-agents, context edges, NEWPLAN, aggregation.
- Selection: JEV/System One, runtime guidance selection, `model=auto`, tool selection.
- Models: catalog, providers, hosters, readiness, invocation, streaming.
- Tools: Pi tools, generated Python tools, sandbox runner, artifacts.

## Dependency direction

```text
contracts/registry
        │
        ├── JEV
        ├── guidance catalog
        ├── model catalog/hoster
        ├── context/artifacts
        └── request management
                │
                ├── guidance selector
                ├── model=auto
                └── Python tools
                        │
                        ▼
                orchestration/sub-agents
                        │
                        ▼
                OpenAI/Ollama API
```

Lower layers must not import higher-level MINAI policy. In particular, JEV is domain-neutral; hosters do not select task intent; API formatting does not enter the task graph.

## Process boundaries

- Pi extensions and trusted TypeScript code run in the Pi process.
- Generated Python is untrusted and runs in a separate runner/sandbox.
- Model processes may be external (Ollama, llama.cpp, remote HTTP, or a future pool).
- The HTTP server may run inside a Pi session or through a standalone gateway entrypoint, but both use the same service contracts.

## Core request flow

```text
request
  → normalize
  → root task
  → JEV-backed guidance decision
  → JEV-backed model decision
  → guidance/model prompt resolution
  → context/artifact construction
  → Pi SDK session
  → tools and artifacts
  → optional NEWPLAN
  → aggregation
  → protocol response
```

## Stage 0 boundary

Stage 0 only implements shared contracts, runtime validation, and a small service registry. It does not implement a provider, hoster, classifier backend, planner, HTTP server, or Python runner.
