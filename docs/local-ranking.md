# Local embeddings for minai-pi

MINAI's `model: "auto"` semantic selection ranks candidates by embedding
similarity. The TS runtime (`minai-pi`) speaks the OpenAI-compatible
`/v1/embeddings` protocol natively (`minai-pi/src/model-embeddings.ts`); what is
missing on this machine is only a server that *serves* an embedding model.

The MINAI extension can launch and manage a local llama.cpp embedding sidecar
itself (`minai-pi/src/local-ranking-host.ts`). Configuration lives in the model
registry file, alongside the hosts/models config it belongs with. Add a
`ranking` section to `minai-pi/models.json`:

```json
{
  "hosts": { "...": "existing generation hosts stay unchanged" },
  "models": [ "...existing models..." ],
  "ranking": {
    "cacheDir": "~/.cache/minai/llama",
    "embedding": {
      "hfRepo": "ggml-org/Qwen3-Embedding-0.6B-GGUF:Q8_0",
      "alias": "qwen3-embedding-0.6b",
      "port": 9300
    },
    "reranker": {
      "hfRepo": "ggml-org/bge-reranker-v2-m3-GGUF",
      "alias": "bge-reranker-v2-m3",
      "port": 9301
    }
  }
}
```

With `hfRepo`, the sidecar downloads the model on first start if it is not
already cached, using `cacheDir` as the download cache (llama-server's
`LLAMA_CACHE`; default `~/.cache/minai/llama`, `~` expanded). Later starts reuse
the cached download. Sidecar start timing: the **embedding** sidecar is lazy —
it spawns (and downloads) on the first actual embed request from `model:
"auto"` selection, so `/minai start` stays instant; set `eager: true` on the
embedding entry to boot it with the runtime. The **reranker** defaults to
eager because nothing inside minai-pi calls it; set `eager: false` to disable
that. Pin an exact file inside the repo with `hfFile` (passed as
`--hf-file`), or give an exact quant in the repo string (`:Q8_0`). First-start
downloads get a generous 10 minute startup timeout by default; override with
`startupTimeoutMs`. Private repos work by exporting `HF_TOKEN`. Use `modelPath`
instead of `hfRepo` to point at an already-downloaded file.

Then start MINAI as usual (`./piminai.sh`, or `/minai start` inside Pi). No
environment variables and no separate script are needed. When `/minai start`
builds the MINAI runtime, it spawns a loopback-only llama-server with
`--embedding --pooling mean`, waits for its `/health` endpoint, points the
embedding client at `http://127.0.0.1:9300/v1`, and stops the process it
started when the runtime stops. An already-healthy endpoint on the port is
adopted as-is instead of spawning a second server.

Per-sidecar keys:

- `hfRepo` — Hugging Face repo (auto-downloaded into `cacheDir` when absent), or `modelPath` — local GGUF file (set exactly one)
- `hfFile` — optional exact file inside `hfRepo`
- `alias` — name sent in API requests (defaults: `qwen3-embedding-0.6b`, `bge-reranker-v2-m3`)
- `port` — default `9300` (embedding) / `9301` (reranker)
- `command` — llama-server binary (default `~/bin/llama-server` when present, else `llama-server` on `PATH`)
- `startupTimeoutMs` — default `120000` (`600000` when `hfRepo` may need to download)
- `cacheDir` — per-sidecar override of the ranking-level `cacheDir`

To keep ranking config outside the registry, point `MINAI_RANKING_CONFIG` at a
standalone JSON file with the same shape; it takes precedence over the
registry's `ranking` section. An explicit `MINAI_EMBEDDING_BASE_URL` +
`MINAI_EMBEDDING_MODEL` still wins for the embedding client itself (any external
OpenAI-compatible API); in that case skip the `embedding` entry to avoid
starting an unused sidecar — `reranker` is independent.

Sidecar logs go to `$TMPDIR/minai-llama-embedding.log` and
`$TMPDIR/minai-llama-reranker.log`. The embedding GGUF must be a model llama.cpp
supports in embedding mode (for example a `Qwen3-Embedding-0.6B` GGUF, the
bi-encoder named in `jev4minai.md`). The alias is only the name sent in API
requests; it does not select or download model files.

With only one eligible registry model, `model: "auto"` still shortcuts without
calling the endpoint. The sidecars bind to `127.0.0.1`; do not expose them on a
network interface. minai-pi itself never calls the reranker; that endpoint is
for external clients.
