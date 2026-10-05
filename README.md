# MINAI on Pi

This package is the new TypeScript/Pi implementation of MINAI. It is being built as small, independently useful Pi extensions rather than as a port of the existing Python runtime.

The implementation plan is at [`../MINAI_ON_PI_PROJECT_PLAN.md`](./MINAI_ON_PI_PROJECT_PLAN.md).

## Current implementation

The package now includes:

- shared contracts and optional services;
- JEV/System One validation and guidance/model selection;
- a Pi guidance extension that loads the existing Python MINAI JSON catalog and instruction fragments;
- context, artifacts, Python tools, orchestration, and structured `NEWPLAN`;
- OpenAI and Ollama-compatible HTTP endpoints;
- Pi request sessions and managed Python/llama-serve local hosts;
- streaming, caller-tool continuations, model listing, authentication, and
  active-run cancellation.

<<<<<<< HEAD
See [`CONFIGURATION.md`](pi-minai/CONFIGURATION.md) for runtime configuration and
security guidance. The [`RELEASE_CHECKLIST.md`](pi-minai/RELEASE_CHECKLIST.md)
=======
See [`CONFIGURATION.md`](pi-minai/CONFIGURATION.md) for runtime configuration and
security guidance. The [`RELEASE_CHECKLIST.md`](pi-minai/RELEASE_CHECKLIST.md)
>>>>>>> 004107b (docs: move the package README to the repository root)
records Phase 11 validation and public-release follow-up work.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Pi commands

When the extension is loaded in Pi, use:

```text
/minai start_http
/minai stop_http
/minai status
/minai runs
/minai watch
/minai stop_watch
/minai thinking
/minai models
/minai guidances
/minai-guidances
/minai-guidance code_review
```

`/minai runs` displays model, guidance, thinking mode, token usage, current task,
continuation/tool-pause IDs, and accumulated streamed output. `/minai watch`
repeats that state while requests are active; any other `/minai` command stops
the watch. `/minai thinking` focuses on reasoning/output state.

`start_http` starts configured managed model-host processes before opening HTTP,
waits for their health endpoint, and registers a temporary Pi provider/model
named `minai/minai` pointing at the new listener. The provider is removed when
HTTP stops. It reads `MINAI_HTTP_PORT`, `MINAI_HTTP_HOST`,
`MINAI_MODEL_REGISTRY`/`MINAI_REGISTRY_PATH`, `MINAI_HTTP_TOKEN`, and
`MINAI_MAX_CONCURRENT_PER_HOST`. The listener and managed hosts are stopped
automatically during Pi session shutdown.

The package is private while the design stabilizes. It can later be published as a Pi package or moved to a personal GitHub repository.
