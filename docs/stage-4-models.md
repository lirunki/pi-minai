# Stage 4 — Model catalog and hosting boundary

Stage 4 defines how MINAI describes and invokes models without deciding which model a task should use. `model=auto` is a later consumer of this boundary.

## Catalog service

`ModelCatalogService` owns validated `AvailableModel` records and supports lookup/list/filter. Filtering is capability and availability filtering only; ranking and JEV-based selection remain outside the catalog.

A model record includes provider/id, context/output limits, tools/vision/reasoning/streaming capabilities, locality, availability, and optional quality/cost metadata.

## Hoster service

`ModelHostService` answers how to invoke a pinned model:

- readiness lookup;
- one-shot invocation;
- streaming invocation;
- abort through `AbortSignal`;
- explicit unknown/unavailable model errors.

The hoster does not select models, resolve guidance, build context, or own orchestration. Ollama, llama.cpp, Pi providers, remote OpenAI-compatible endpoints, and the old pool can later be adapters behind this interface.

Stage 4 includes an in-memory hoster with injected handlers. It is a test seam and a usable local application seam, not a provider implementation.

## Normalized invocation

```ts
{ model: { provider, id }, messages, tools?, temperature?, maxOutputTokens? }
```

Results are normalized to text plus optional provider metadata. Streaming emits text deltas and a final usage/finish event through an async iterable.

## Lifecycle

The catalog is request-independent and can be shared. Hoster adapters may own processes or connections later; those resources must be started lazily and closed by the Pi session owner. The in-memory hoster has no resources.

## Acceptance

- Invalid model records fail at construction.
- Catalog filtering can enforce hard capability requirements.
- Invocation and streaming require a catalog model that is available.
- Unknown and offline models produce stable errors.
- Abort signals reach injected handlers.
- No model ranking or `auto` policy is implemented here.
