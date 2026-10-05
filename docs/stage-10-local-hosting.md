# Stage 10 — local model hosting backends

Local hosting is behind the existing `ModelHostService`. Concrete backends are `PythonMinaiHost` and `LlamaServeHost`, both using simple loopback HTTP and supporting streaming.

## Filesystem registry

The host registry is a JSON file. It is loaded by `FileModelHostRegistry.load(path)`; the registry does not spawn processes or run a supervisor.

```json
{
  "hosts": {
    "python-local": {
      "backend": "python-minai",
      "baseUrl": "http://127.0.0.1:9100"
    },
    "llama-local": {
      "backend": "llama-serve",
      "baseUrl": "http://127.0.0.1:9200"
    }
  },
  "models": [
    {
      "provider": "python-minai",
      "id": "my-safetensors-model",
      "host": "python-local",
      "locality": "local",
      "availability": "ready",
      "contextWindow": 8192,
      "maxOutputTokens": 2048,
      "capabilities": {"tools": true, "vision": false, "reasoning": true, "streaming": true}
    }
  ]
}
```

The registry provides model lookup, catalog access, host lookup, and model-to-host lookup. `RegistryModelRouter` feeds the same catalog into `ModelAutoSelector`, then resolves the selected model to its configured host. Process startup and supervision remain outside this intentionally simple file-backed layer. `ModelExecutionRouter` provides the direct host-backed execution path, including text, thinking, and streaming events; the public MINAI HTTP listener remains unchanged.

## Process boundary

```text
Pi/MINAI TypeScript
  └── loopback HTTP ──> reusable Python MINAI host
                         ├── safetensors runtime
                         └── GGUF runtime
```

The Python process may serve multiple clients and requests. TypeScript does not import Python modules or execute Python inside the Pi process. `llama-serve` follows the same loopback boundary.
