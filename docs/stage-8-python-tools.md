# Stage 8 — Python tool manifest and isolated runner

## Boundary

The Python extension owns tool manifests, catalog lookup, and execution policy. It does not import generated Python into Pi. Every tool runs in a child process; a future OS/container sandbox can replace the process runner behind the same interface.

Pi-facing operations will later be exposed as registered tools:

```text
list_python_tools(search?)
create_python_tool(definition)
run_python_tool(name, args)
```

This stage implements the catalog and runner seam, not JEV-backed search or model-generated tool creation.

## Manifest

A manifest contains:

- safe name and description;
- tags;
- JSON-like input schema metadata;
- entrypoint path;
- permissions;
- version/status;
- timeout and output limits.

Statuses are `draft`, `active`, or `disabled`. Only `active` tools run.

## Trust boundary

The runner invokes the configured Python executable with an entrypoint and sends arguments as JSON on stdin. It parses one JSON result from stdout. Python source is never imported or evaluated by TypeScript.

The process runner enforces:

- workspace-root path containment;
- active status;
- declared permission allowlists;
- timeout;
- output-size limit;
- abort/kill;
- sanitized environment.

Filesystem/network/subprocess permissions are policy declarations at this stage. Real OS enforcement requires a sandbox adapter and must not be implied by the plain child-process runner. A later production runner must use a real sandbox for untrusted generated tools.

## Result contract

```ts
{ ok: true, value: unknown, stdout?: string, stderr?: string }
{ ok: false, error: string, code: string, stdout?: string, stderr?: string }
```

Malformed stdout, non-zero exit, timeout, and cancellation are failures. Tool output is not automatically imported into Pi context; orchestration may publish it as an artifact.

## Non-responsibilities

No JEV classifier, tool selection policy, generated-code creator, artifact persistence, or Pi tool registration is implemented in this slice.
