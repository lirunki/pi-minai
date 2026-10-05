# Stage 2 — Guidance catalog and runtime selector

Stage 2 separates guidance content from guidance selection.

## Catalog

`GuidanceCatalog` owns validated definitions and prompt instances. A definition has an ID, description, optional purpose/tags, and one or more model-matching instances. Resolution chooses the lowest-ranked matching instance, with generic instances as fallback.

The catalog does not call JEV or a model. It can be backed by static objects now and JSON loading can be added without changing the service boundary.

## Selector

`GuidanceSelector` receives a query and runtime state, then:

1. honors an explicit valid guidance ID;
2. otherwise creates one generic `ChoiceQuestion` with every catalog ID as criteria;
3. calls `candidate:system-one` with the literal `{ state, model, questions }` request;
4. interprets the returned choice only if it is declared and meets the configured confidence threshold;
5. falls back deterministically to `general_qa`, or the first catalog entry if it is absent.

JEV remains domain-neutral. The selector owns the meaning of the choice and owns fallback policy. The public JEV answer is not extended with guidance metadata.

## State

The selector passes an object state containing only deliberate routing context:

```ts
{ query, taskQuery?, parentRole?, hasCode?, hasAttachments?, hasTools?, contextSizeClass? }
```

Consumers may provide additional serializable fields through `runtime`, but the selector does not include transcripts or secrets automatically.

## Service boundary

- `catalog:guidance` exposes `GuidanceCatalogService`.
- `selector:guidance` exposes `GuidanceSelectorService`.

Both services are independently testable with `FakeSystemOneService`.

## Acceptance

- Existing guidance IDs and descriptions can be represented without changing JEV.
- Catalog resolution supports generic and model-specific instances.
- Explicit valid guidance bypasses JEV.
- Invalid/absent explicit guidance uses JEV.
- Low-confidence or unavailable JEV uses deterministic fallback.
- JEV receives one Choice question with the catalog criteria.
- No free-form model-generated guidance names are accepted as normal selection.
