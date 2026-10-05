# Stage 1 — JEV/System One contract and remote backend

## Responsibility

The JEV extension provides one generic System One service:

```text
systemOne({ state, model, questions }) -> validated SystemOneResponse
```

It does not know what a guidance, model-routing decision, or Python tool means. Consumers create TypeSafe/Jev questions and interpret typed answers.

## Backends in this stage

- `remote`: POST the literal request to `https://api.typesafe.ai/v1/systemone` or a configured compatible base URL.
- `fake`: deterministic injected service for offline tests and later consumer tests.
- `resolver`: selects one backend from explicit configuration.

Local FlashRank, embedding, local Qwen, and fallback-LLM tiers are Stage 3. This stage must not preemptively add domain-specific local behavior.

## Remote behavior

The remote backend:

1. validates the outgoing request;
2. POSTs JSON to `/v1/systemone`;
3. sends `Content-Type: application/json` and optional bearer authentication;
4. honors an `AbortSignal` and timeout policy;
5. rejects non-2xx responses with a typed error;
6. parses JSON;
7. validates the response against the request's questions;
8. returns only the validated System One response.

It must not rewrite question IDs, add MINAI metadata, or convert answers into domain decisions.

## Configuration

```ts
type SystemOneBackend = "remote" | "fake";

type JEVRemoteConfig = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
};

type JEVConfig = {
  backend: SystemOneBackend;
  remote: JEVRemoteConfig;
};
```

The implementation should accept an injected `fetch` function for testing. Do not read secrets at module import time.

## Errors

Use `MinaiPiError` with stable codes:

- `contract_validation`: request or response violates System One shape;
- `jev_http`: remote response is non-2xx;
- `jev_timeout`: request was aborted by timeout;
- `jev_transport`: network/JSON transport failure;
- `jev_backend`: configured backend cannot be resolved.

The original error may be retained as `cause`, but public callers should be able to branch on `code`.

## Service registration

The extension registers its service under:

```text
candidate:system-one
```

The registered value implements `SystemOneService`. Registration must be explicit and replaceable during tests/reload.

## Pi lifecycle

Stage 1 has no long-lived resources. The extension factory registers the service. Later local-model backends must defer model/process startup until `session_start` or first use.

## Acceptance

- A request can be sent to a configurable TypeSafe-compatible endpoint.
- The outgoing body is byte-for-byte semantically identical to the input request.
- Valid Choice, Score, Noul, and batched responses are accepted.
- Invalid responses are rejected before reaching consumers.
- HTTP errors, timeout/abort, and malformed JSON have stable error codes.
- Fake services allow all tests to run offline.
- No guidance, model, or tool policy exists in this extension.
