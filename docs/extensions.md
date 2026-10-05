# MINAI on Pi — Stage 0 extension decomposition

Each extension is independently loadable and communicates through registered services. The initial package may ship all extensions together, but their ownership boundaries are intentional.

| Extension | Owns | Does not own |
|---|---|---|
| JEV/System One | literal System One API and remote/local backends | guidance, models' business meaning, task orchestration |
| Guidance | definitions and model-specific prompt instances | runtime selection |
| Guidance selector | creates guidance Choice questions and interprets answers | classifier implementation |
| Model hosting | catalog, provider adapters, model lifecycle/invocation | task intent and routing policy |
| `model=auto` | capability filtering and model Choice questions | model process lifecycle |
| Context/artifacts | prompt layers, artifact references, context budgets | task scheduling |
| Python tools | tool manifests, JEV-backed discovery, creation, isolated execution | general orchestration |
| Orchestration | planner, graph, scheduler, sub-agents, NEWPLAN, aggregation | protocol formatting, model hosting |
| OpenAI/Ollama API | HTTP routes, normalization, streaming, auth | planning and selection |
| Observability/request management | request state, events, cancellation, inspection | domain decisions |

## Services

The Stage 0 registry reserves these names:

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

A service is optional unless a later extension explicitly declares it required. Consumers must use deterministic fallback or a clear capability error when an optional service is absent.

## Pi lifecycle expectations

Extensions with resources must start them during `session_start` or on first use, not at module import. They must clean them up during `session_shutdown`. HTTP listeners, model processes, timers, file watchers, and sandbox runners are session-scoped resources unless the standalone gateway owns them.

## Extension-specific interfaces

Detailed interfaces are introduced in later phases. Stage 0 defines only stable shared contracts and service names. Domain implementations must not be added to `src/contracts` merely to avoid designing their own extension boundary.
