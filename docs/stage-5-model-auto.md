# Stage 5 — `model=auto` selector

The model selector chooses a pinned model for one task. It consumes the model catalog and optionally JEV; it never starts model processes or invokes a model.

## Selection order

1. Apply hard capability/locality requirements to the catalog.
2. If an explicit model is requested, honor it under `strict` policy when it exists, is ready, and satisfies requirements. Under `route`, select from eligible candidates if the explicit model is unavailable or incompatible.
3. For `auto`, send one generic JEV Choice question whose criteria are the eligible provider/model keys and descriptions.
4. Accept a declared JEV choice only when confidence meets the threshold.
5. Otherwise deterministically rank eligible models by readiness, quality, locality preference, cost, and stable key order.
6. Return the selected `ModelReference`; the caller pins it to the task.

JEV receives only `{ state, model, questions }`. Model selection policy and interpretation belong to this extension.

## Policy

- `explicitPolicy: "strict"` is the default.
- `explicitPolicy: "route"` allows fallback routing for a bad explicit request.
- `minConfidence` defaults to `0.5`.
- An unavailable JEV service is not fatal when deterministic fallback is possible.
- An empty eligible set is a typed capability error.

## Boundary

The selector does not invoke `ModelHostService`, mutate catalog records, or select a new model for sibling tasks. Each task selection call is independent.
