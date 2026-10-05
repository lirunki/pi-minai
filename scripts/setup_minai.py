#!/usr/bin/env python3
"""All-up MINAI setup: local model hosts, remote providers, ranking sidecars.

Merge-only by design: whatever is already in the MINAI model registry
(pi-minai/models.json) is kept verbatim — this script only fills gaps and
reports exactly what it adds. Remote provider suggestions come from the Pi
model catalog (~/.pi/agent/models.json), reusing its credentials via
apiKeyCatalog so no key is ever copied or stored here.

Usage:
  scripts/setup_minai.py [--yes] [--dry-run] [--registry PATH] [--pi-catalog PATH]

  --yes          accept every suggestion without prompting
  --dry-run      print the plan, write nothing
  --registry     MINAI model registry path (default: <repo>/pi-minai/models.json)
  --pi-catalog   Pi model catalog path (default: ~/.pi/agent/models.json)
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_REGISTRY = REPO / "pi-minai" / "models.json"
DEFAULT_CATALOG = Path.home() / ".pi" / "agent" / "models.json"
DEFAULT_CACHE = Path.home() / ".cache" / "minai" / "llama"
LLAMA_BIN = Path.home() / "bin" / "llama-server"

# Providers that are MINAI's own services or local llama.cpp — never remote suggestions.
INTERNAL_PROVIDERS = {"minai", "pidev", "llama-server"}

# Curated local suggestions: fast fallback + math specialist.
LOCAL_SUGGESTIONS = [
    {
        "host_id": "snapdragon-vulkan",
        "host": {"backend": "llama-serve", "baseUrl": "http://127.0.0.1:9200",
                 "process": {"command": str(LLAMA_BIN), "args": ["-m", str(Path.home() / "models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"),
                                                                "--host", "127.0.0.1", "--port", "9200", "-c", "32768"],
                             "startupTimeoutMs": 60000, "shutdownTimeoutMs": 5000,
                             "logFile": os.environ.get("TMPDIR", "/tmp") + "/minai-llama-serve.log"}},
        "model": {"provider": "llama-serve", "id": "qwen2.5-0.5b", "host": "snapdragon-vulkan",
                  "description": "Small local Qwen2.5 instruction model served by llama.cpp; low resource use and basic text generation, with limited reasoning capacity.",
                  "locality": "local", "availability": "ready", "contextWindow": 32768, "maxOutputTokens": 1024,
                  "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}, "quality": 25},
        "label": "qwen2.5-0.5b — local fast fallback (~350 MB file, must exist)",
    },
    {
        "host_id": "snapdragon-phi3",
        "host": {"backend": "llama-serve", "baseUrl": "http://127.0.0.1:9201",
                 "process": {"command": str(LLAMA_BIN), "hfRepo": "microsoft/Phi-3-mini-4k-instruct-gguf",
                             "hfFile": "Phi-3-mini-4k-instruct-q4.gguf", "cacheDir": str(DEFAULT_CACHE),
                             "args": ["--host", "127.0.0.1", "--port", "9201", "-c", "4096", "--alias", "phi3-mini-math", "--no-webui"],
                             "startupTimeoutMs": 900000, "shutdownTimeoutMs": 5000,
                             "logFile": os.environ.get("TMPDIR", "/tmp") + "/minai-llama-phi3.log"}},
        "model": {"provider": "llama-serve", "id": "phi3-mini-math", "host": "snapdragon-phi3",
                  "description": "Local Phi-3-mini math specialist; strong arithmetic, word problems, and algorithmic reasoning; offline and free but slower, with a short 4k context and no tool calling.",
                  "locality": "local", "availability": "ready", "contextWindow": 4096, "maxOutputTokens": 1024,
                  "capabilities": {"tools": False, "vision": False, "reasoning": False, "streaming": True}, "quality": 65},
        "label": "phi3-mini-math — local math specialist (~2.3 GB auto-download)",
    },
]

# Known-good hosted picks per provider; anything unknown falls back to its first models.
REMOTE_SUGGESTIONS = {
    "cheaperinference": [
        {"id": "glm-5.3-flash", "description": "Hosted fast cheap generalist on the cheaperinference flash tier; everyday tasks, routing, and aggregation.",
         "contextWindow": 131072, "maxOutputTokens": 8192, "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}, "quality": 55, "cost": {"input": 0.2, "output": 1.0}},
        {"id": "deepseek-v4-flash", "description": "Hosted cheap reasoning specialist on the cheaperinference flash tier; math, code analysis, and step-by-step work.",
         "contextWindow": 131072, "maxOutputTokens": 8192, "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}, "quality": 60, "cost": {"input": 0.3, "output": 1.2}},
        {"id": "glm-5.2", "description": "Hosted mid-tier planner on cheaperinference; complex synthesis and multi-step planning; pricier than the flash models but far below gpt-6-luna.",
         "contextWindow": 131072, "maxOutputTokens": 8192, "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}, "quality": 70, "cost": {"input": 0.8, "output": 3.0}},
    ],
}
REMOTE_EXCLUDE = {"gpt-6-luna"}  # cost ceiling; add deliberately if ever wanted

RANKING_SUGGESTION = {"embedding": {"hfRepo": "Qwen/Qwen3-Embedding-0.6B-GGUF", "hfFile": "Qwen3-Embedding-0.6B-Q8_0.gguf",
                                    "alias": "qwen3-embedding-0.6b", "cacheDir": str(DEFAULT_CACHE), "port": 9300}}


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as error:
        sys.exit(f"error: {path} is not valid JSON: {error}")


def ask(prompt: str, default: bool, assume_yes: bool) -> bool:
    if assume_yes:
        return default
    suffix = " [Y/n] " if default else " [y/N] "
    while True:
        answer = input(prompt + suffix).strip().lower()
        if not answer:
            return default
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("  please answer y or n")


def preflight(catalog: Path, registry: Path) -> list:
    problems = []
    if not LLAMA_BIN.exists() and not shutil.which("llama-server"):
        problems.append(f"llama-server binary not found at {LLAMA_BIN} or on PATH — local hosts will fail to spawn")
    if not shutil.which("node"):
        problems.append("node not found on PATH — MINAI services need node")
    if not registry.parent.exists():
        problems.append(f"registry directory missing: {registry.parent}")
    return problems


def remote_provider_suggestions(catalog: dict) -> list:
    suggestions = []
    for name, provider in (catalog.get("providers") or {}).items():
        if name in INTERNAL_PROVIDERS or not provider.get("baseUrl") or not provider.get("apiKey"):
            continue
        if "openai" not in str(provider.get("api", "openai")):
            continue
        known = REMOTE_SUGGESTIONS.get(name)
        if known:
            models = known
        else:
            models = []
            for entry in (provider.get("models") or [])[:3]:
                mid = entry.get("id") if isinstance(entry, dict) else str(entry)
                if mid:
                    models = models + [{"id": mid, "description": f"Hosted model {mid} via the {name} provider.",
                                        "contextWindow": 131072, "maxOutputTokens": 8192,
                                        "capabilities": {"tools": True, "vision": False, "reasoning": False, "streaming": True}}]
        models = [m for m in models if m["id"] not in REMOTE_EXCLUDE]
        if models:
            suggestions.append({"provider": name, "baseUrl": provider["baseUrl"], "models": models})
    return suggestions


def main() -> None:
    parser = argparse.ArgumentParser(description="Set up MINAI hosts, models, and ranking sidecars (merge-only).")
    parser.add_argument("--yes", action="store_true", help="accept all suggestions without prompting")
    parser.add_argument("--dry-run", action="store_true", help="print the plan without writing")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--pi-catalog", type=Path, default=DEFAULT_CATALOG)
    args = parser.parse_args()

    registry_path = args.registry.expanduser()
    catalog_path = args.pi_catalog.expanduser()

    print(f"MINAI setup — registry: {registry_path}")
    existing = load_json(registry_path) or {}
    hosts = dict(existing.get("hosts") or {})
    models = list(existing.get("models") or [])
    ranking = dict(existing.get("ranking") or {})
    if existing:
        print(f"  current state: {len(hosts)} hosts, {len(models)} models, ranking={'set' if ranking else 'none'} (all kept unless absent)")
    else:
        print("  no existing registry found — starting fresh")

    problems = preflight(catalog_path, registry_path)
    for problem in problems:
        print(f"  warning: {problem}")

    added_hosts, added_models, notes = [], [], []

    # --- local hosts/models ---
    print("\nLocal models (suggested defaults):")
    for suggestion in LOCAL_SUGGESTIONS:
        model_id = suggestion["model"]["id"]
        have_model = any(m.get("id") == model_id for m in models)
        have_host = suggestion["host_id"] in hosts
        state = "kept" if have_model else "missing"
        print(f"  - {suggestion['label']}  [{state}]")
        if have_model:
            continue
        if ask(f"    add {model_id}?", default=True, assume_yes=args.yes):
            if not have_host:
                hosts[suggestion["host_id"]] = suggestion["host"]
                added_hosts.append(suggestion["host_id"])
            models.append(suggestion["model"])
            added_models.append(model_id)
            notes.append(f"{model_id}: ensure the model file/repo exists on first use")

    # --- remote providers from the Pi catalog ---
    print("\nRemote providers (from the Pi catalog; credentials stay in the catalog via apiKeyCatalog):")
    catalog = load_json(catalog_path) or {}
    for suggestion in remote_provider_suggestions(catalog):
        name = suggestion["provider"]
        have_host = name in hosts
        ids = ", ".join(m["id"] for m in suggestion["models"])
        print(f"  - {name} ({suggestion['baseUrl']}): {ids}  [{'host kept' if have_host else 'not configured'}]")
        new_models = [m for m in suggestion["models"] if not any(x.get("provider") == name and x.get("id") == m["id"] for x in models)]
        if have_host and not new_models:
            continue
        if ask(f"    add {name} host" + ("" if have_host else "") + (f" + {len(new_models)} model(s)?" if new_models else "?"), default=True, assume_yes=args.yes):
            if not have_host:
                hosts[name] = {"backend": "openai", "baseUrl": suggestion["baseUrl"], "chatPath": "/chat/completions",
                               "healthPath": "/models", "apiKeyEnv": f"MINAI_{name.upper()}_API_KEY", "apiKeyCatalog": name}
                added_hosts.append(name)
            for model in new_models:
                models.append({"provider": name, "id": model["id"], "host": name, **model})
                added_models.append(f"{name}/{model['id']}")

    # --- ranking / embedding sidecar ---
    print("\nRanking (local embedding sidecar for semantic model selection):")
    if ranking:
        print("  - ranking already configured — kept verbatim")
    elif ask("    add the Qwen3-Embedding-0.6B sidecar on 127.0.0.1:9300 (lazy, ~640 MB download)?", default=True, assume_yes=args.yes):
        ranking.update(RANKING_SUGGESTION)
        notes.append("ranking: embedding model downloads on first selection")

    # --- plan ---
    added = [f"host {h}" for h in added_hosts] + [f"model {m}" for m in added_models] + (["ranking.embedding"] if ranking and "ranking" not in (existing or {}) and RANKING_SUGGESTION["embedding"] == ranking.get("embedding") else [])
    print("\nPlan:")
    if added:
        for item in added:
            print(f"  + {item}")
    for note in notes:
        print(f"  ! {note}")
    if not added and not notes:
        print("  nothing to add — registry already complete")

    if args.dry_run:
        print("\ndry run — nothing written")
        return
    if added and not ask("\nwrite the registry?", default=True, assume_yes=args.yes):
        print("aborted — nothing written")
        return

    if added:
        if registry_path.exists():
            backup = registry_path.with_suffix(f".json.bak-{time.strftime('%Y%m%d-%H%M%S')}")
            shutil.copy2(registry_path, backup)
            print(f"backup: {backup}")
        document = {**existing, "hosts": hosts, "models": models, **({"ranking": ranking} if ranking else {})}
        registry_path.write_text(json.dumps(document, indent=2) + "\n")
        print(f"written: {registry_path}")
    else:
        print("nothing to write")

    # best-effort validation with the real parser
    if (REPO / "pi-minai" / "node_modules").exists():
        try:
            script = ("import { parseLocalRankingHostsOptions } from './src/local-ranking-host.js';"
                      "import { readFileSync } from 'node:fs';"
                      "const doc = JSON.parse(readFileSync(process.env.MINAI_SETUP_REGISTRY, 'utf8'));"
                      "if (doc.ranking) parseLocalRankingHostsOptions(doc);"
                      "console.log('registry parses cleanly');")
            env = {**os.environ, "MINAI_SETUP_REGISTRY": str(registry_path)}
            result = subprocess.run(["node", "--import", "tsx", "--eval", script],
                                    cwd=REPO / "pi-minai", capture_output=True, text=True, timeout=120, env=env)
            if result.returncode == 0:
                print(result.stdout.strip())
            else:
                print(f"warning: registry validation failed:\n{result.stderr.strip()[:500]}")
        except Exception as error:  # non-fatal
            print(f"warning: skipped parser validation: {error}")

    print("\nnext steps:")
    print("  1. restart the Pi session that hosts MINAI (config is read at boot)")
    print("  2. /minai start — instant; hosts spawn lazily on first selection")
    print("  3. send a model:\"auto\" request — the embedding sidecar starts on first multi-candidate ranking")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\naborted")
