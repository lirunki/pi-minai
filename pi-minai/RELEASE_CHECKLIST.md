# Release checklist

Phase 11 hardening and packaging is complete for the current private package.
Use this checklist before making the package public.

## Automated checks

- [x] `npm run typecheck`
- [x] `npm run pack:check`
- [x] HTTP Pi/local-host integration tests
- [x] authentication and owner-isolation tests
- [x] cancellation and shutdown lifecycle tests
- [x] model listing and streaming tests

## Runtime checks

- [x] HTTP requests use request-owned Pi sessions.
- [x] Local hosts are external loopback services.
- [x] Host concurrency is bounded when configured.
- [x] Active runs are cancelled during shutdown.
- [x] Tool continuations are owner-bound and TTL-limited.
- [x] Metrics and cancellation routes follow bearer authentication.

## Security review

- [x] Generated Python is never imported into the Pi process.
- [x] Generated Python executes out of process.
- [x] Host registries do not spawn or supervise processes.
- [x] Loopback hosting and authentication guidance is documented.
- [ ] Add an OS-level sandbox before accepting hostile generated code.

## Public release follow-up

- [ ] Set `private` to `false` only when publication is intended.
- [ ] Add repository, license, bugs, and homepage metadata.
- [ ] Add CI for typecheck, tests, and `npm pack --dry-run`.
- [ ] Run real-process Python and llama-serve integration tests.
- [ ] Record direct/planned and JEV local/remote benchmark results.
- [ ] Tag the first public version and publish release notes.
