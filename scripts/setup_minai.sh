#!/usr/bin/env bash
# MINAI turnkey setup — one command to make a machine ready to run piminai.
#
# Merge-only by design: whatever already exists (model registry, Pi catalog
# entries, downloaded models) is kept verbatim; this script only fills gaps.
# It sets up, in order:
#   1. preflight checks (node, npm, python3, llama-server, pi)
#   2. the llama.cpp model cache directory
#   3. node_modules for the pi-minai package (npm install if missing)
#   4. the guidance catalog (shipped under guidances/; verified, not generated)
#   5. the model registry: local hosts/models, remote providers (keys stay in
#      the Pi catalog and are referenced via apiKeyCatalog — never copied),
#      and the ranking (embedding) sidecar
#   6. the Pi catalog: llama-server, pidev, and minai providers
#   7. a typecheck so you know the checkout is healthy
#
# Usage:
#   scripts/setup_minai.sh [--dry-run] [--registry PATH] [--pi-catalog PATH]
#     [--skip-typecheck] [--no-install]
#
#   --dry-run         print the plan, write nothing
#   --registry        MINAI model registry (default: <repo>/pi-minai/models.json)
#   --pi-catalog      Pi model catalog (default: ~/.pi/agent/models.json)
#   --skip-typecheck  skip the final npm run typecheck
#   --no-install      skip npm install even if node_modules is missing

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="$REPO/pi-minai"
REGISTRY="$PACKAGE/models.json"
CATALOG="$HOME/.pi/agent/models.json"
CACHE="$HOME/.cache/minai/llama"
LLAMA_BIN="$HOME/bin/llama-server"
GUIDANCES="$REPO/guidances"

DRY_RUN=0
SKIP_TYPECHECK=0
NO_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --registry) REGISTRY="${2:?path required}"; shift ;;
    --pi-catalog) CATALOG="${2:?path required}"; shift ;;
    --skip-typecheck) SKIP_TYPECHECK=1 ;;
    --no-install) NO_INSTALL=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
step() { printf '\n== %s\n' "$*"; }

DRY_FLAG=""
[ "$DRY_RUN" = 1 ] && DRY_FLAG=dry

say "MINAI setup — repo: $REPO"
say "  registry: $REGISTRY"
say "  pi catalog: $CATALOG"
[ "$DRY_RUN" = 1 ] && say "  mode: DRY RUN (nothing will be written)"

step "1/7 preflight"
MISSING_REQUIRED=0
for tool in node npm python3; do
  if command -v "$tool" >/dev/null 2>&1; then say " ok: $tool"; else warn "$tool not found on PATH"; MISSING_REQUIRED=1; fi
done
[ "$MISSING_REQUIRED" = 1 ] && { echo "error: install the missing tools above and re-run." >&2; exit 1; }
if [ -x "$LLAMA_BIN" ] || command -v llama-server >/dev/null 2>&1; then
  say " ok: llama-server"
else
  warn "llama-server not found at $LLAMA_BIN or on PATH — local hosts will fail to spawn (remote providers still work)"
fi
command -v pi >/dev/null 2>&1 && say " ok: pi" || warn "pi not found on PATH — needed to run piminai.sh"

step "2/7 model cache"
if [ "$DRY_RUN" = 1 ]; then
  say " dry: would ensure $CACHE exists"
else
  mkdir -p "$CACHE"
  say " ok: $CACHE"
fi

step "3/7 package dependencies"
if [ -d "$PACKAGE/node_modules" ]; then
  say " ok: node_modules present"
elif [ "$NO_INSTALL" = 1 ]; then
  warn "node_modules missing and --no-install given"
elif [ "$DRY_RUN" = 1 ]; then
  say " dry: would run npm install in $PACKAGE"
else
  (cd "$PACKAGE" && npm install --no-audit --no-fund)
  say " ok: npm install complete"
fi

step "4/7 guidance catalog"
GUIDANCE_COUNT=$(find "$GUIDANCES" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
if [ "$GUIDANCE_COUNT" -gt 0 ]; then
  say " ok: $GUIDANCE_COUNT guidance definitions in $GUIDANCES"
else
  warn "no guidance definitions found in $GUIDANCES — /minai-guidance selection will be empty"
fi

step "5/7 model registry (merge-only)"
BACKUP=""
if [ -f "$REGISTRY" ] && [ "$DRY_RUN" != 1 ]; then
  say " (a timestamped backup is made before any write)"
fi
python3 - "$REGISTRY" "$CATALOG" "$DRY_FLAG" "$CACHE" "$LLAMA_BIN" "${TMPDIR:-/tmp}" <<'PY'
import json, os, sys
from pathlib import Path

registry_path, catalog_path, dry, cache, llama_bin, tmpdir = sys.argv[1:7]
dry = dry == "dry"
internal = {"minai", "pidev", "llama-server"}
remote_exclude = {"gpt-6-luna"}  # cost ceiling; add deliberately if ever wanted
log = lambda name: f"{tmpdir}/minai-llama-{name}.log"

def load(path):
    p = Path(path)
    if not p.exists(): return {}
    try: return json.loads(p.read_text())
    except json.JSONDecodeError as e: sys.exit(f"error: {p} is not valid JSON: {e}")

def local_suggestions():
    home = Path.home()
    return [
        {"host_id": "snapdragon-vulkan",
         "host": {"backend": "llama-serve", "baseUrl": "http://127.0.0.1:9200",
                  "process": {"command": llama_bin, "args": ["-m", str(home / "models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"),
                              "--host", "127.0.0.1", "--port", "9200", "-c", "32768"],
                              "startupTimeoutMs": 60000, "shutdownTimeoutMs": 5000, "logFile": log("serve")}},
         "model": {"provider": "llama-serve", "id": "qwen2.5-0.5b", "host": "snapdragon-vulkan",
                   "description": "Small local Qwen2.5 instruction model served by llama.cpp; low resource use and basic text generation, with limited reasoning capacity.",
                   "locality": "local", "availability": "ready", "contextWindow": 32768, "maxOutputTokens": 1024,
                   "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}, "quality": 25},
         "label": "qwen2.5-0.5b — local fast fallback (~350 MB file, must exist)"},
        {"host_id": "snapdragon-phi3",
         "host": {"backend": "llama-serve", "baseUrl": "http://127.0.0.1:9201",
                  "process": {"command": llama_bin, "hfRepo": "microsoft/Phi-3-mini-4k-instruct-gguf",
                              "hfFile": "Phi-3-mini-4k-instruct-q4.gguf", "cacheDir": cache,
                              "args": ["--host", "127.0.0.1", "--port", "9201", "-c", "4096",
                                       "--alias", "phi3-mini-math", "--no-webui"],
                              "startupTimeoutMs": 900000, "shutdownTimeoutMs": 5000, "logFile": log("phi3")}},
         "model": {"provider": "llama-serve", "id": "phi3-mini-math", "host": "snapdragon-phi3",
                   "description": "Local Phi-3-mini math specialist; strong arithmetic, word problems, and algorithmic reasoning; offline and free but slower, with a short 4k context and no tool calling.",
                   "locality": "local", "availability": "ready", "contextWindow": 4096, "maxOutputTokens": 1024,
                   "capabilities": {"tools": False, "vision": False, "reasoning": False, "streaming": True}, "quality": 65},
         "label": "phi3-mini-math — local math specialist (~2.3 GB auto-download)"},
    ]

remote_known = {
    "cheaperinference": [
        {"id": "glm-5.3-flash", "description": "Hosted fast cheap generalist on the cheaperinference flash tier; everyday tasks, routing, and aggregation.",
         "contextWindow": 131072, "maxOutputTokens": 8192, "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}, "quality": 55, "cost": {"input": 0.2, "output": 1.0}},
        {"id": "deepseek-v4-flash", "description": "Hosted cheap reasoning specialist on the cheaperinference flash tier; math, code analysis, and step-by-step work.",
         "contextWindow": 131072, "maxOutputTokens": 8192, "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}, "quality": 60, "cost": {"input": 0.3, "output": 1.2}},
        {"id": "glm-5.2", "description": "Hosted mid-tier planner on cheaperinference; complex synthesis and multi-step planning; pricier than the flash models but far below gpt-6-luna.",
         "contextWindow": 131072, "maxOutputTokens": 8192, "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}, "quality": 70, "cost": {"input": 0.8, "output": 3.0}},
    ],
}
ranking_suggestion = {"embedding": {"hfRepo": "Qwen/Qwen3-Embedding-0.6B-GGUF", "hfFile": "Qwen3-Embedding-0.6B-Q8_0.gguf",
                                    "alias": "qwen3-embedding-0.6b", "cacheDir": cache, "port": 9300}}

registry = load(registry_path)
hosts = dict(registry.get("hosts") or {})
models = list(registry.get("models") or [])
ranking = dict(registry.get("ranking") or {})
changes = []

print(f" registry: {len(hosts)} hosts, {len(models)} models, ranking={'set' if ranking else 'none'} (existing entries kept verbatim)")

for s in local_suggestions():
    mid = s["model"]["id"]
    if any(m.get("id") == mid for m in models):
        print(f" kept: {s['label']}"); continue
    hosts.setdefault(s["host_id"], s["host"]); models.append(s["model"])
    changes.append(f"added local {mid}")
    print(f" {'dry: would add' if dry else 'added'}: {s['label']}")

catalog = load(catalog_path)
for name, provider in (catalog.get("providers") or {}).items():
    if name in internal or not provider.get("baseUrl") or not provider.get("apiKey"): continue
    if "openai" not in str(provider.get("api", "openai")): continue
    picks = remote_known.get(name) or [
        {"id": e.get("id", str(e)) if isinstance(e, dict) else str(e),
         "description": f"Hosted model {e.get('id', e)} via the {name} provider.",
         "contextWindow": 131072, "maxOutputTokens": 8192,
         "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}}
        for e in (provider.get("models") or [])[:3]]
    picks = [m for m in picks if m["id"] not in remote_exclude]
    new = [m for m in picks if not any(x.get("provider") == name and x.get("id") == m["id"] for x in models)]
    host_state = "host kept" if name in hosts else "host missing"
    if not new and name in hosts:
        print(f" kept: {name} ({provider['baseUrl']})"); continue
    if name not in hosts:
        hosts[name] = {"backend": "openai", "baseUrl": provider["baseUrl"],
                       "chatPath": "/chat/completions", "healthPath": "/models",
                       "apiKeyCatalog": name}
    models.extend([{**m, "provider": name} for m in new])
    changes.append(f"added remote {name}: {', '.join(m['id'] for m in new) or 'no new models'}")
    print(f" {'dry: would add' if dry else 'added'}: {name} ({provider['baseUrl']}) {host_state} — {', '.join(m['id'] for m in new) or 'no new models'} (key via apiKeyCatalog)")

if not ranking.get("embedding"):
    ranking.update(ranking_suggestion)
    changes.append("added ranking.embedding (local sidecar, port 9300)")
    print(f" {'dry: would add' if dry else 'added'}: ranking.embedding — Qwen3-Embedding-0.6B (auto-download, port 9300)")
else:
    print(" kept: ranking.embedding")

if dry:
    print(f"\ndry run complete — {len(changes)} change(s) would be written to {registry_path}")
elif changes:
    backup = f"{registry_path}.backup-{__import__('time').strftime('%Y%m%d-%H%M%S')}"
    Path(registry_path).exists() and Path(registry_path).read_text() and __import__('shutil').copy2(registry_path, backup)
    print(f" backup: {backup}")
    Path(registry_path).write_text(json.dumps({**registry, "hosts": hosts, "models": models, "ranking": ranking}, indent=2) + "\n")
    json.loads(Path(registry_path).read_text())  # validate what we wrote
    print(f"\nregistry written: {len(changes)} change(s)")
else:
    print("\nregistry already complete — no changes, file left untouched")
PY

step "6/7 Pi catalog providers (llama-server, pidev, minai)"
LLAMA_SERVER_URL="http://127.0.0.1:9200/v1" \
python3 - "$CATALOG" "$DRY_FLAG" <<'PY'
import json, sys
from pathlib import Path
path, dry = Path(sys.argv[1]), sys.argv[2] == "dry"
try: doc = json.loads(path.read_text()) if path.exists() else {}
except json.JSONDecodeError as e: sys.exit(f"error: {path} is not valid JSON: {e}")
providers = doc.setdefault("providers", {})
want = {
    "llama-server": {"baseUrl": "http://127.0.0.1:9200/v1", "api": "openai-completions",
                     "models": [{"id": "qwen2.5-0.5b", "name": "qwen2.5-0.5b", "reasoning": False, "input": ["text"],
                                 "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                                 "contextWindow": 32768, "maxTokens": 1024}]},
    "pidev": {"baseUrl": "http://127.0.0.1:8787/v1", "api": "openai-completions",
              "models": [{"id": "pidev", "name": "Pi Dev", "reasoning": False, "input": ["text"],
                          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                          "contextWindow": 22048, "maxTokens": 2560}]},
    "minai": {"baseUrl": "http://127.0.0.1:8788/v1", "api": "openai-completions",
              "models": [{"id": "minai", "name": "MINAI", "reasoning": False, "input": ["text"],
                          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                          "contextWindow": 22048, "maxTokens": 2560}]},
}
changed = []
for name, cfg in want.items():
    provider = providers.get(name)
    if isinstance(provider, dict) and provider.get("baseUrl") and provider.get("models"):
        print(f" kept: {name} -> {provider['baseUrl']}"); continue
    if dry:
        print(f" dry: would add provider {name} -> {cfg['baseUrl']}"); changed.append(name); continue
    merged = dict(cfg)
    merged["apiKey"] = (provider or {}).get("apiKey", f"{name}-local")
    merged["compat"] = (provider or {}).get("compat", {"supportsDeveloperRole": False, "supportsReasoningEffort": False})
    merged.setdefault("models", cfg["models"])
    providers[name] = merged
    changed.append(name)
    print(f" added: {name} -> {cfg['baseUrl']}")
if not dry and changed:
    path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"pi catalog updated: {', '.join(changed)}")
PY

step "7/7 typecheck"
if [ "$SKIP_TYPECHECK" = 1 ]; then
  say " skipped"
elif [ ! -d "$PACKAGE/node_modules" ]; then
  warn "node_modules missing — skipping typecheck (run npm install)"
elif [ "$DRY_RUN" = 1 ]; then
  say " dry: would run npm run typecheck"
else
  (cd "$PACKAGE" && npm run typecheck) && say " ok: typecheck clean"
fi

step "done"
say "next: ./piminai.sh  then, inside Pi:  /minai start_http"
