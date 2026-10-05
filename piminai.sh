#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

# Start Pi with the local MINAI HTTP/management extension loaded.
# /minai start_http exposes Pi as pidev; /minai start exposes MINAI and
# starts the configured llama-server.

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
MINAI_PI="$SCRIPT_DIR/minai-pi"
REGISTRY="${MINAI_MODEL_REGISTRY:-$MINAI_PI/models.json}"
export MINAI_CLEAN=0
export MINAI_ROOT="$SCRIPT_DIR"
export MINAI_PI
export MINAI_MODEL_REGISTRY="$REGISTRY"
export MINAI_GUIDANCE_ROOT="${MINAI_GUIDANCE_ROOT:-$MINAI_ROOT/guidances}"
export MINAI_HTTP_HOST="${MINAI_HTTP_HOST:-127.0.0.1}"
export MINAI_PI_HTTP_PORT="${MINAI_PI_HTTP_PORT:-8787}"
export MINAI_HTTP_PORT="${MINAI_HTTP_PORT:-8788}"
export MINAI_PI_CONTEXT_WINDOW="${MINAI_PI_CONTEXT_WINDOW:-32768}"
export LLAMA_SERVER_URL="${LLAMA_SERVER_URL:-http://127.0.0.1:9200/v1}"
LLAMA_PORT="$(printf '%s' "$LLAMA_SERVER_URL" | sed -n 's#.*:\([0-9][0-9]*\).*#\1#p')"
LLAMA_PORT="${LLAMA_PORT:-9200}"

# Optional local embedding/reranking sidecars are launched and owned by the
# MINAI extension itself: add a "ranking" section to the model registry
# ($MINAI_MODEL_REGISTRY) or point MINAI_RANKING_CONFIG at a standalone JSON file.

# Offer to clean up lingering MINAI/llama servers from previous runs. Every
# kill requires explicit confirmation (or MINAI_CLEAN=1 for unattended runs).
port_busy() { curl -s -o /dev/null --connect-timeout 1 --max-time 2 "http://127.0.0.1:$1/" 2>/dev/null; [ "$?" -ne 7 ]; }
show_cmdline() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null; echo; }
kill_pids() {
  local label="$1"; shift
  echo "Found $label:"
  for pid in "$@"; do printf '  pid %s: ' "$pid"; show_cmdline "$pid"; done
  if [ "$MINAI_CLEAN" = "1" ]; then reply=y
  elif [ -t 0 ]; then read -r -p "Kill these $label processes? [y/N] " reply
  else reply=n; fi
  case "$reply" in
    y|Y|yes|Yes)
      kill "$@" 2>/dev/null || true
      sleep 1
      kill -9 "$@" 2>/dev/null || true
      printf 'Killed %s.\n' "$label"
      ;;
    *)
      echo "Left running; the matching endpoint may fail to bind its port."
      ;;
  esac
}
if [ "$MINAI_CLEAN" != "0" ]; then
  if port_busy "$LLAMA_PORT"; then
    pids=$(pgrep -f "llama-server.*--port $LLAMA_PORT" 2>/dev/null | tr '\n' ' ')
    [ -n "$pids" ] && kill_pids "llama-server on port $LLAMA_PORT" $pids
  fi
  if port_busy "$MINAI_PI_HTTP_PORT" || port_busy "$MINAI_HTTP_PORT"; then
    pids=$(pgrep -f 'node pi' 2>/dev/null | tr '\n' ' ')
    [ -n "$pids" ] && kill_pids "Pi sessions (may hold MINAI HTTP ports $MINAI_PI_HTTP_PORT/$MINAI_HTTP_PORT)" $pids
    pids=$(pgrep -f 'python3 -$' 2>/dev/null | tr '\n' ' ')
    [ -n "$pids" ] && kill_pids "stale Python MINAI servers" $pids
  fi
fi
export MINAI_HTTP_STRICT_PORT="${MINAI_HTTP_STRICT_PORT:-0}"
export MINAI_MAX_CONCURRENT_PER_HOST="${MINAI_MAX_CONCURRENT_PER_HOST:-1}"
export MINAI_FORCE_PLANNING="${MINAI_FORCE_PLANNING:-0}"
export LLAMA_SERVER_MODEL="${LLAMA_SERVER_MODEL:-qwen2.5-0.5b}"

# Add a Pi model that talks directly to the managed llama-server. This is
# separate from minai/minai, which talks to MINAI's HTTP adapter.
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_MODELS_FILE="$PI_AGENT_DIR/models.json"
mkdir -p "$PI_AGENT_DIR"
python3 - "$PI_MODELS_FILE" "$LLAMA_SERVER_URL" "$LLAMA_SERVER_MODEL" "$MINAI_PI_HTTP_PORT" "$MINAI_PI_CONTEXT_WINDOW" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
url = sys.argv[2]
model_id = sys.argv[3]
pidev_port = sys.argv[4]
pidev_context = int(sys.argv[5])
try:
    document = json.loads(path.read_text()) if path.exists() else {}
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"Error: cannot read Pi model catalog {path}: {exc}")

providers = document.setdefault("providers", {})
if not isinstance(providers, dict):
    raise SystemExit(f"Error: Pi model catalog has invalid providers: {path}")
provider = providers.setdefault("llama-server", {})
if not isinstance(provider, dict):
    raise SystemExit(f"Error: Pi llama-server provider has invalid configuration: {path}")
provider.update({
    "baseUrl": url,
    "api": "openai-completions",
    "apiKey": provider.get("apiKey", "llama-local"),
    "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
})
models = provider.setdefault("models", [])
if not isinstance(models, list):
    raise SystemExit(f"Error: Pi llama-server models must be a list: {path}")
model = {
    "id": model_id,
    "name": model_id,
    "reasoning": False,
    "input": ["text"],
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    "contextWindow": 32768,
    "maxTokens": 1024,
}
provider["models"] = [item for item in models if not (isinstance(item, dict) and item.get("id") == model_id)] + [model]
pidev = providers.setdefault("pidev", {})
if not isinstance(pidev, dict):
    raise SystemExit(f"Error: Pi pidev provider has invalid configuration: {path}")
pidev.update({
    "baseUrl": f"http://127.0.0.1:{pidev_port}/v1",
    "api": "openai-completions",
    "apiKey": "pidev-local",
})
pidev_models = pidev.setdefault("models", [])
if not isinstance(pidev_models, list):
    raise SystemExit(f"Error: Pi pidev models must be a list: {path}")
pidev_model = {
    "id": "pidev",
    "name": "Pi Dev",
    "reasoning": False,
    "input": ["text"],
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    "contextWindow": pidev_context,
    "maxTokens": 1024,
}
pidev["models"] = [item for item in pidev_models if not (isinstance(item, dict) and item.get("id") == "pidev")] + [pidev_model]
path.write_text(json.dumps(document, indent=2) + "\n")
print(f"Pi model catalog updated: llama-server/{model_id} -> {url}; pidev/pidev -> http://127.0.0.1:{pidev_port}/v1")
PY

if ! command -v pi >/dev/null 2>&1; then
  printf 'Error: pi was not found on PATH.\n' >&2
  exit 1
fi

if [ ! -f "$MINAI_PI/extensions/http.ts" ]; then
  printf 'Error: MINAI HTTP extension not found: %s\n' "$MINAI_PI/extensions/http.ts" >&2
  exit 1
fi

if [ ! -f "$MINAI_MODEL_REGISTRY" ]; then
  printf 'Error: model registry not found: %s\n' "$MINAI_MODEL_REGISTRY" >&2
  printf 'Expected the machine-local registry at: %s/models.json\n' "$MINAI_PI" >&2
  exit 1
fi

printf 'Starting Pi with MINAI extension\n'
printf '  project:  %s\n' "$MINAI_ROOT"
printf '  registry: %s\n' "$MINAI_MODEL_REGISTRY"
printf '  HTTP:     http://%s:%s\n' "$MINAI_HTTP_HOST" "$MINAI_HTTP_PORT"
printf '\nInside Pi, run:\n'
printf '  /minai start_http\n'
printf '  /minai status\n'
printf '  /minai models\n\n'

cd "$MINAI_ROOT"
exec pi -e "$MINAI_PI/extensions/http.ts" -e "$MINAI_PI/extensions/planning.ts" -e "$MINAI_PI/extensions/jev.ts" -e "$MINAI_PI/extensions/guidance.ts" "$@"
