# MINAI on Pi

MINAI (`piminai`) is a collection of small, independently useful [Pi](https://github.com/earendil-works/pi-coding-agent) extensions — not a port of the old Python runtime. Together they turn a Pi installation into a **local model gateway and orchestrator**:

- **Expose Pi sessions as an OpenAI-compatible endpoint.** Anything Pi can do becomes callable over HTTP (`/v1/chat/completions`), so Pi's model catalog — local llama.cpp servers, remote providers, and MINAI itself — is reachable from any OpenAI or Ollama client, tool, or script.
- **Automatic model selection.** Ask for `model: "auto"` and MINAI picks the best available model per request, using capability filtering, embedding-similarity ranking, a JEV-like classifier, and deterministic quality/cost fallbacks.
- **Turnkey local SLM hosting.** llama.cpp server processes are spawned on demand, models are auto-downloaded from Hugging Face on first use, and healthy endpoints are adopted transparently — plus a local embedding sidecar for ranking.
- **JEV-like classifiers and guidance.** A lightweight "System One" classifier and a filesystem-discovered guidance catalog route each request to the right instruction set and model class.
- **An orchestrator.** Complex tasks are decomposed into a planning board of smaller subtasks with dependencies, each executed with its own preferred guidance, model, and reasoning level, then aggregated into a final answer.

The implementation plan is at [`MINAI_ON_PI_PROJECT_PLAN.md`](./MINAI_ON_PI_PROJECT_PLAN.md).

## The extensions

Each extension is usable on its own; they compose when loaded together.

### `http` — the model gateway (`extensions/http.ts`)

The largest extension. It runs two independent listeners:

- **`pidev`** (default port `8787`) — a raw gateway to isolated Pi SDK sessions: every request gets its own Pi session, so callers get plain LLM completions backed by Pi's full provider stack. This is the "Pi as an OpenAI endpoint" mode.
- **`minai`** (default port `8788`) — the full orchestration endpoint: model routing, planning-board execution, guidance selection, managed local hosts, and the temporary `minai/minai` Pi provider that points back at this listener so Pi sessions can route through it too.

Protocol support (both listeners):

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat, including `stream: true` SSE streaming and tool calling |
| `POST /api/chat`, `POST /api/generate` | Ollama-compatible chat and generate |
| `GET /v1/models` | Model listing (OpenAI shape) |
| `POST /v1/runs/:id/cancel` | Cancel an in-flight run |
| `GET/POST /v1/continuations/:id` | Resume paused tool-call continuations |
| `GET /health` | Liveness probe |

Also built in: bearer-token authentication (`MINAI_HTTP_TOKEN`), per-run tracking (model, guidance, tokens, streamed output) visible via `/minai runs` and `/minai watch`, and a caller-tool bridge that lets an external caller answer tool calls the model makes mid-stream.

### `planning` — the orchestrator (`extensions/planning.ts`)

A planning-board sibling of the todos extension. The board holds the current plan: a goal, subtasks with dependencies and pass-along context, preferred guidance/model/reasoning per subtask, and a final aggregation step. Tools:

- `manage_plan` — read or write the whole plan (schema-validated)
- `newplan` — start a NEWPLAN, discarding any current plan
- `/plan` — show the current board

A footer widget mirrors the board live (✓ completed, ◉ running, ○ pending, ✗ failed, with dependency and preference hints). When the HTTP extension is loaded, each orchestration run's plan progress is streamed into its run state (`plan 2/5` in `/minai watch`).

### `jev` — JEV-like classifiers (`extensions/jev.ts`)

Registers a shared "System One" classifier service (`candidate:system-one`) in the service registry — the fast, cheap judgment layer that scores candidate models/guidances without a full LLM round-trip. The shared service is intentionally not created at import time; a host application configures it, so a plain Pi session stays network-silent.

### `guidance` — filesystem guidance catalog (`extensions/guidance.ts`)

Loads guidance definitions (instruction sets + selection rules) as **configuration, not code**:

- Discovers every `.json` under `MINAI_GUIDANCE_ROOT` (default `./guidances`), recursively — adding a guidance is adding a file.
- Understands the original Python-era JSON shape, so existing catalogs work as-is; `<<./fragment.md>>` references expand relative to each file's own directory.
- Feeds the guidance selector used by `model: "auto"` and the planning board.
- Commands: `/minai guidances`, `/minai-guidances`, `/minai-guidance <id>`.

The shipped catalog under [`guidances/`](./guidances) covers planning (`plan_query`, `plan_docwrite`), math (`math_problem_solving`), code (`code_analysis`, `code_authoring`, `code_review`), documentation writing, research, QA, final-answer synthesis, and utility guidance (context compression, query splitting, best-model/best-guidance selection).

## Automatic model selection (`model: "auto"`)

Requests that ask for `auto` run through a layered pipeline, stopping at the first layer with a confident answer:

1. **Capability & readiness filtering** — models whose host is unhealthy, unauthenticated, or lacking required features (e.g. tool calling) are dropped.
2. **Single-candidate shortcut** — if only one model remains, it is used immediately (no sidecars woken up).
3. **Embedding-similarity ranking** — the request is embedded and compared against per-model exemplars, using a local embedding sidecar (lazy-started on first use).
4. **JEV / System One classifier** — a small classifier model breaks ties.
5. **Deterministic fallback** — highest quality-rank available, cheapest first.

When a guidance is selected, its instance rules (`rank`, `model_class_regex`, temperature) refine the choice further.

## Local model hosting

Hosts are declared in the model registry ([`pi-minai/models.json`](./pi-minai/models.json)) and everything about them is lazy:

- **llama.cpp hosts** (`backend: "llama-serve"`) — spawned on the first request that needs them, or adopted if an endpoint is already healthy. Models are auto-downloaded from Hugging Face (`hfRepo`/`hfFile`) into the shared cache (`~/.cache/minai/llama`) on first use.
- **Embedding / reranker sidecars** — the embedding sidecar starts on the first embed request; the reranker defaults to eager; either can be pinned with an `eager` override.
- **Remote OpenAI-compatible hosts** (`backend: "openai"`, e.g. cheaperinference) — API keys are read per-request from an environment variable or the Pi model catalog (`apiKeyCatalog`); keys are never stored in repo files.
- **Health management** — hosts that fail health checks (including 401/403 from dead credentials) drop out of `auto` routing; health is re-probed every 60 s, so rotating a key needs no restart. Per-host concurrency is capped (`MINAI_MAX_CONCURRENT_PER_HOST`).

## The launcher: `piminai.sh`

Run from the repository root (any working directory works):

```bash
./piminai.sh
```

For a fresh machine, `scripts/setup_minai.sh` is the turnkey one-shot: it
preflights the tools, creates the model cache, runs `npm install`, verifies
the guidance catalog, fills the model registry (local hosts/models, remote
providers, ranking sidecar — merge-only, with backup), seeds the Pi catalog
providers, and typechecks the checkout. Safe to re-run at any time:

```bash
scripts/setup_minai.sh            # full turnkey setup
scripts/setup_minai.sh --dry-run  # preview only
```

It wires the environment (`MINAI_ROOT`, `MINAI_PI`, `MINAI_MODEL_REGISTRY`, `MINAI_GUIDANCE_ROOT`, ports `8787`/`8788`, llama-server settings), merges the `llama-server` and `pidev` providers into the Pi model catalog (`~/.pi/agent/models.json`) without touching unrelated entries, and starts Pi with all four extensions loaded.

Inside Pi:

```text
/minai start_http      # start managed hosts, wait for health, open HTTP
/minai status          # listener, hosts, registry, runtime state
/minai models          # catalog summary with quality ranks and tools flags
/minai runs            # live run state (model, guidance, tokens, plan progress)
/minai watch           # repeat run state while requests are active
/minai thinking        # reasoning/output focus
/minai stop_http       # close listeners, remove the minai/minai provider
/minai-guidance code_review
```

Listeners and managed hosts shut down automatically when the Pi session exits.

## Configuration

Runtime configuration lives in three places, all outside the code:

- **Model registry** — `pi-minai/models.json`: hosts (process commands, endpoints, auth sources), models (quality ranks, tool support, aliases), and the `ranking` section (embedding sidecar). Machine-local overrides via `MINAI_MODEL_REGISTRY`.
- **Guidance catalog** — `guidances/` (or `MINAI_GUIDANCE_ROOT`): JSON definitions + markdown fragments, discovered from the filesystem.
- **Environment** — `MINAI_HTTP_PORT`, `MINAI_PI_HTTP_PORT`, `MINAI_HTTP_HOST`, `MINAI_HTTP_TOKEN`, `MINAI_MODEL_REGISTRY`, `MINAI_GUIDANCE_ROOT`, `MINAI_MAX_CONCURRENT_PER_HOST`, `MINAI_HTTP_STRICT_PORT`, `MINAI_CLEAN`, `LLAMA_SERVER_MODEL`, plus host-specific key variables.

See [`pi-minai/CONFIGURATION.md`](./pi-minai/CONFIGURATION.md) for the full reference and security guidance; [`pi-minai/RELEASE_CHECKLIST.md`](./pi-minai/RELEASE_CHECKLIST.md) records release validation work.

## Development

```bash
npm install        # inside pi-minai/
npm run typecheck
npm test
```

The package can later be published as a Pi package; for now it is developed and run from this repository.
