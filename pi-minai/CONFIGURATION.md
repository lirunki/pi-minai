# MINAI on Pi configuration

`HttpExtensionRuntime` can run against Pi sessions or configured local model hosts.

## Pi mode

```ts
new HttpExtensionRuntime({
  port: 8787,
  mode: "pi",
  model: "provider/model",
  bearerToken: process.env.MINAI_HTTP_TOKEN,
});
```

Pi mode creates an isolated request-owned Pi session for every HTTP request.
The interactive Pi session is never reused by the HTTP listener.

## Local-host mode

```ts
new HttpExtensionRuntime({
  port: 8787,
  mode: "local-host",
  registryPath: "./config/models.json",
  maxConcurrentPerHost: 2,
  refreshHostHealth: true,
});
```

The registry is a small JSON file. It describes hosts and may optionally tell
MINAI to start and stop their processes. Hosts are started before the HTTP
listener is made ready and stopped during `runtime.stop()` or Pi shutdown.

The process command must be explicitly configured. Keep it to a trusted
absolute executable and trusted arguments; the registry is not a general
purpose shell.

For this Snapdragon/Termux machine, the existing Vulkan wrapper is:

```text
/data/data/com.termux/files/home/bin/llama-server
```

Example managed host:

```json
{"hosts":{"snapdragon-vulkan":{"backend":"llama-serve","baseUrl":"http://127.0.0.1:9200","process":{"command":"/data/data/com.termux/files/home/bin/llama-server","args":["-m","/data/data/com.termux/files/home/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf","--host","127.0.0.1","--port","9200","-c","32768"],"startupTimeoutMs":60000,"inheritOutput":true}}},"models":[{"provider":"llama-serve","id":"qwen2.5-0.5b","host":"snapdragon-vulkan","locality":"local","availability":"ready","contextWindow":32768,"maxOutputTokens":256,"capabilities":{"tools":false,"vision":false,"reasoning":false,"streaming":true}}]}
```

Managed `llama-serve` processes start lazily: the process spawns on the first
request that selects one of its models, not at `/minai start`. Set `eager: true`
inside `process` to keep the old eager boot. Instead of a local model file,
`process.hfRepo` (+ optional `hfFile`) auto-downloads the GGUF on first use
into `process.cacheDir` (exposed to llama-server as `LLAMA_CACHE`; created on
demand). Hosted providers use `backend: "openai"` with `baseUrl`, `chatPath`
(default `/chat/completions`), and one of two credential sources resolved per
request: `apiKeyEnv` names an environment variable, and `apiKeyCatalog` names a
provider in the shared Pi model catalog (`~/.pi/agent/models.json`, e.g.
`"apiKeyCatalog": "cheaperinference"` reads `providers.cheaperinference.apiKey`).
When both are set, the env var wins and the catalog is the fallback, so no
launcher export is required. Health is reachability-based; HTTP 401/403 on the
probe marks the host not-ready so bad credentials drop out of `auto` routing.

The Python MINAI backend uses the same `process` shape, but its command should
start the Python loopback HTTP server and its `baseUrl` should point to that
server.

## Automatic model selection

Send `"model": "auto"` or use the MINAI model alias to choose among registry
models. MINAI first filters candidates by request requirements (for example, tool and streaming
support). If exactly one candidate remains, it selects it immediately without
calling an embedding service or classifier.

With multiple eligible candidates, configure an OpenAI-compatible embedding
endpoint to rank the request against each candidate's description and
capabilities. Add a `description` to each model registry entry to capture what
it is best suited for; model IDs alone are weak semantic descriptions. MINAI
computes cosine similarities and softmaxes them; if the leading probability
meets the confidence threshold, it selects that candidate.
If embeddings are unconfigured, unavailable, or uncertain, MINAI falls through
to a model-backed JEV/System One choice classifier. If that classifier is also
uncertain or unavailable, MINAI uses its existing deterministic availability,
locality, and quality ranking.

For a llama.cpp embedding endpoint launched by the MINAI extension itself, see
[`docs/local-ranking.md`](../docs/local-ranking.md): add a `ranking` section to
the model registry (`models.json`) and `/minai start` runs a loopback sidecar on
port 9300 and stops it with the runtime.

Environment settings for `piminai.sh` / the MINAI runtime:

- `MINAI_EMBEDDING_BASE_URL` (optional; OpenAI-compatible API prefix, e.g. `http://127.0.0.1:9300/v1`)
- `MINAI_EMBEDDING_MODEL` (required with the base URL; must be an embedding model)
- `MINAI_EMBEDDING_API_KEY` (optional)
- `MINAI_EMBEDDING_MIN_CONFIDENCE` (default `0.75`)
- `MINAI_EMBEDDING_TEMPERATURE` (default `0.1`; positive number)
- `MINAI_CLASSIFIER_MODEL` (optional `provider/model`; defaults to the first healthy registry model)
- `MINAI_CLASSIFIER_MIN_CONFIDENCE` (default `0.65`)

The embedding service is called at `<MINAI_EMBEDDING_BASE_URL>/embeddings` with
both the request text and eligible-model descriptions in one batch. Do not point
it at a chat-only model endpoint. The classifier uses the configured classifier
model through its registered model host and returns a JEV choice among eligible
candidates.

## Pi command configuration

Inside Pi, `/minai start_http` starts the runtime using these environment variables
and registers the temporary Pi model `minai/minai` against the started
`http://127.0.0.1:<port>/v1` endpoint. `/minai stop_http` removes that provider
and stops the managed hosts.

- `MINAI_HTTP_PORT` (default `8787`)
- `MINAI_HTTP_HOST` (default `127.0.0.1`)
- `MINAI_MODEL_REGISTRY` or `MINAI_REGISTRY_PATH`
- `MINAI_HTTP_TOKEN`
- `MINAI_MAX_CONCURRENT_PER_HOST` (default `1`)

The guidance extension loads all JSON files recursively from
`MINAI_GUIDANCE_ROOT` and expands Python-style `<<./fragment.md>>` instruction
references. It registers `catalog:guidance` and `selector:guidance` in the
shared Pi-process service registry.

Useful commands are `/minai status`, `/minai runs`, `/minai watch`,
`/minai stop_watch`, `/minai thinking`, `/minai models`, `/minai guidances`, and
`/minai stop_http`. The guidance commands `/minai-guidances` and
`/minai-guidance <id>` list and inspect the loaded catalog. Run snapshots include model, guidance, thinking state,
usage, current task, continuation IDs, and accumulated streamed output.

## HTTP endpoints

- `GET /health`
- `GET /metrics` (active HTTP run lifecycle counters)
- `GET /v1/models`
- `GET /api/tags`
- `POST /v1/chat/completions`
- `POST /api/chat`
- `POST /api/generate`
- `POST /v1/runs/:id/cancel`
- `POST /v1/continuations/:id`

When a streamed OpenAI chat request pauses for caller tools, MINAI emits a standard
`tool_calls` delta and ends that response with `finish_reason: "tool_calls"`.
The emitted tool-call `id` is the continuation ID. A client may resume either
through `POST /v1/continuations/:id` with its tool result, or by sending a
follow-up `/v1/chat/completions` request containing the assistant tool call and
matching `tool` messages (`tool_call_id` = emitted ID). MINAI uses those results
to resume the parked request; it does not start a new model turn. Ollama keeps
its MINAI continuation event and uses the explicit continuation endpoint.

Set `bearerToken` to require `Authorization: Bearer <token>`. When callers
use multiple tenants, set `x-minai-owner` consistently; active runs and tool
continuations are restricted to their owner.

## Operational guidance

- Keep model hosts bound to loopback unless an authenticated reverse proxy is
  explicitly configured.
- Use `maxConcurrentPerHost` to prevent one local backend from exhausting
  resources.
- Call `stop()` during process shutdown; it aborts active requests before
  closing the listener and Pi sessions.
- Treat generated Python tools as untrusted. They execute out of process, but a
  production OS-level sandbox remains required for hostile workloads.
