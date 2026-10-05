# Stage 9 — dependency-light HTTP listener design

The listener is a Node `fetch`-style handler, not a second orchestration runtime. It translates HTTP requests through the existing protocol adapters and Pi session/continuation services.

## Routes

- `POST /v1/chat/completions` — OpenAI Chat Completions.
- `POST /api/chat` — Ollama Chat.
- `POST /api/generate` — Ollama Generate.
- `GET /health` — health response.

A later extension can attach this handler to a Node server or Pi session lifecycle. Keeping the handler independent of a framework makes route and stream tests deterministic.

## Handler boundary

```ts
handle(request: Request): Promise<Response>
```

The handler owns:

- method/path dispatch;
- authentication and body-size checks;
- JSON decoding;
- protocol parser selection;
- non-stream adapter dispatch;
- SSE/NDJSON serialization;
- request abort propagation;
- continuation request routing.

It does not own model selection, Pi context, provider calls, or tool execution.

## Streaming

OpenAI uses `text/event-stream` with JSON `data:` frames and a final `[DONE]`. Ollama uses newline-delimited JSON objects. The response body is a `ReadableStream`; each normalized event is serialized immediately. The handler observes `request.signal` and cancels the adapter when the client disconnects.

## Continuations

OpenAI tool continuations use ordinary streamed `tool_calls` chunks, with the
continuation ID as the tool-call ID and `finish_reason: "tool_calls"`. Clients
can submit results through the explicit continuation endpoint or include them
as matching `tool` messages in a follow-up chat request. The listener maps those
messages to the parked execution and resumes it. Ollama retains its MINAI pause
event and explicit continuation endpoint.

## Security and limits

- optional bearer authentication, checked before parsing the body;
- bounded body read;
- bounded JSON/tool-result size;
- only known routes/methods;
- no arbitrary model/provider URLs;
- request cancellation propagated to Pi.

The listener is intentionally not a production server yet: TLS, proxy trust, rate limiting, and durable continuation storage remain deployment concerns.
