import { existsSync } from "node:fs";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelHostProcess, type ModelHostProcessOptions } from "./model-host-process.js";
import { OpenAiCompatibleEmbeddingService, type TextEmbeddingService } from "./model-embeddings.js";

export type LocalRankingSidecarKind = "embedding" | "reranker";

export type LocalRankingSidecarOptions = {
  kind: LocalRankingSidecarKind;
  port: number;
  alias: string;
  modelPath?: string;
  hfRepo?: string;
  hfFile?: string;
  cacheDir: string;
  command?: string;
  startupTimeoutMs?: number;
  /** Embedding sidecars default to lazy (first embed request); rerankers default to eager (no internal caller). */
  eager?: boolean;
};

export type LocalRankingHostsOptions = { embedding?: LocalRankingSidecarOptions; reranker?: LocalRankingSidecarOptions };

export type LocalRankingSidecarConfig = { modelPath?: unknown; hfRepo?: unknown; hfFile?: unknown; cacheDir?: unknown; alias?: unknown; port?: unknown; command?: unknown; startupTimeoutMs?: unknown; eager?: unknown };
export type LocalRankingConfig = { cacheDir?: unknown; embedding?: unknown; reranker?: unknown };

const DEFAULT_PORTS: Record<LocalRankingSidecarKind, number> = { embedding: 9300, reranker: 9301 };
const DEFAULT_ALIASES: Record<LocalRankingSidecarKind, string> = { embedding: "qwen3-embedding-0.6b", reranker: "bge-reranker-v2-m3" };

function fail(message: string): never { throw new Error(`Invalid local ranking config: ${message}`); }

function cacheDirConfig(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string" || !raw.trim()) fail("cacheDir must be a non-empty string");
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

function sidecarConfig(kind: LocalRankingSidecarKind, raw: unknown, defaultCacheDir: string): LocalRankingSidecarOptions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${kind} must be an object`);
  const value = raw as LocalRankingSidecarConfig;
  const modelPath = typeof value.modelPath === "string" && value.modelPath.trim() ? value.modelPath.trim() : undefined;
  const hfRepo = typeof value.hfRepo === "string" && value.hfRepo.trim() ? value.hfRepo.trim() : undefined;
  const hfFile = typeof value.hfFile === "string" && value.hfFile.trim() ? value.hfFile.trim() : undefined;
  if (!modelPath && !hfRepo) fail(`${kind} must define modelPath or hfRepo`);
  if (modelPath && hfRepo) fail(`set only one of ${kind}.modelPath and ${kind}.hfRepo`);
  if (hfFile && !hfRepo) fail(`${kind}.hfFile requires ${kind}.hfRepo`);
  const alias = value.alias === undefined ? DEFAULT_ALIASES[kind] : typeof value.alias === "string" && value.alias.trim() ? value.alias.trim() : fail(`${kind}.alias must be a non-empty string`);
  const port = value.port === undefined ? DEFAULT_PORTS[kind] : typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 ? value.port : fail(`${kind}.port must be a valid TCP port`);
  const command = value.command === undefined ? undefined : typeof value.command === "string" && value.command.trim() ? value.command.trim() : fail(`${kind}.command must be a non-empty string`);
  const startupTimeoutMs = value.startupTimeoutMs === undefined ? undefined : typeof value.startupTimeoutMs === "number" && Number.isFinite(value.startupTimeoutMs) && value.startupTimeoutMs > 0 ? value.startupTimeoutMs : fail(`${kind}.startupTimeoutMs must be a positive number`);
  const eager = value.eager === undefined ? kind === "reranker" : typeof value.eager === "boolean" ? value.eager : fail(`${kind}.eager must be a boolean`);
  return {
    kind,
    port,
    alias,
    cacheDir: cacheDirConfig(value.cacheDir, defaultCacheDir),
    ...(modelPath ? { modelPath } : { hfRepo }),
    ...(hfFile ? { hfFile } : {}),
    ...(command === undefined ? {} : { command }),
    ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
    eager,
  };
}

/** Sidecar options from a parsed config document; undefined when no ranking section is present. */
export function parseLocalRankingHostsOptions(document: unknown): LocalRankingHostsOptions | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const ranking = (document as Record<string, unknown>).ranking;
  if (ranking === undefined || ranking === null) return undefined;
  if (typeof ranking !== "object" || Array.isArray(ranking)) fail("ranking must be an object");
  const value = ranking as LocalRankingConfig;
  const defaultCacheDir = path.join(os.homedir(), ".cache", "minai", "llama");
  const cacheDir = cacheDirConfig(value.cacheDir, defaultCacheDir);
  const embedding = value.embedding === undefined || value.embedding === null ? undefined : sidecarConfig("embedding", value.embedding, cacheDir);
  const reranker = value.reranker === undefined || value.reranker === null ? undefined : sidecarConfig("reranker", value.reranker, cacheDir);
  if (!embedding && !reranker) fail("ranking must define embedding or reranker");
  return { ...(embedding ? { embedding } : {}), ...(reranker ? { reranker } : {}) };
}

/**
 * Sidecar options from a config file (a model registry document with an
 * optional top-level "ranking" key, e.g. models.json). Returns undefined when
 * the file is missing or has no ranking section.
 */
export function loadLocalRankingHostsOptions(configPath: string): LocalRankingHostsOptions | undefined {
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(configPath, "utf8")); } catch (error) { throw new Error(`Could not read local ranking config ${configPath}: ${error instanceof Error ? error.message : String(error)}`); }
  return parseLocalRankingHostsOptions(parsed);
}

function sidecarArgs(sidecar: LocalRankingSidecarOptions): string[] {
  const source = sidecar.modelPath ? ["-m", sidecar.modelPath] : sidecar.hfFile ? ["-hf", sidecar.hfRepo!, "-hff", sidecar.hfFile] : ["-hf", sidecar.hfRepo!];
  const mode = sidecar.kind === "embedding" ? ["--embedding", "--pooling", "mean"] : ["--rerank"];
  return [...source, ...mode, "--host", "127.0.0.1", "--port", String(sidecar.port), "--alias", sidecar.alias, "--no-webui"];
}

/** Spawn plan for one sidecar; exported for tests and diagnostics. */
export function localRankingSidecarProcessOptions(sidecar: LocalRankingSidecarOptions): ModelHostProcessOptions {
  const timeoutDefault = sidecar.hfRepo ? 600_000 : 120_000; // first HF download can be slow
  return {
    command: sidecar.command ?? defaultLlamaServerCommand(),
    args: sidecarArgs(sidecar),
    startupTimeoutMs: sidecar.startupTimeoutMs ?? timeoutDefault,
    logFile: path.join(os.tmpdir(), `minai-llama-${sidecar.kind}.log`),
    env: { LLAMA_CACHE: sidecar.cacheDir },
  };
}

function defaultLlamaServerCommand(): string {
  const bundled = path.join(os.homedir(), "bin", "llama-server");
  return existsSync(bundled) ? bundled : "llama-server";
}

/**
 * Owns optional local llama.cpp embedding/reranking sidecars for MINAI services.
 * Each sidecar binds to loopback only. An already-healthy endpoint is left
 * running (not owned); processes started here are stopped by stop().
 * Embedding sidecars start lazily on the first embed request unless eager;
 * rerankers start with start() by default because nothing internal calls them.
 */
export class LocalRankingHosts {
  private readonly processes = new Map<LocalRankingSidecarKind, ModelHostProcess>();
  private readonly started = new Set<LocalRankingSidecarKind>();
  private embeddingService?: TextEmbeddingService;

  constructor(private readonly options: LocalRankingHostsOptions) {}
  get embeddingBaseUrl(): string | undefined { const sidecar = this.options.embedding; return sidecar ? `http://127.0.0.1:${sidecar.port}/v1` : undefined; }
  get embeddingModel(): string | undefined { return this.options.embedding?.alias; }
  process(kind: LocalRankingSidecarKind): ModelHostProcess | undefined { return this.processes.get(kind); }

  /** Embedding client that spawns the sidecar (and downloads its model) on first use. */
  embedding(): TextEmbeddingService {
    if (!this.options.embedding) throw new Error("No embedding sidecar is configured");
    this.embeddingService ??= new OpenAiCompatibleEmbeddingService({ baseUrl: this.embeddingBaseUrl!, model: this.embeddingModel! });
    return {
      embed: async (texts: string[], signal?: AbortSignal) => {
        await this.ensureStarted("embedding");
        return this.embeddingService!.embed(texts, signal);
      },
    };
  }

  private sidecar(kind: LocalRankingSidecarKind): LocalRankingSidecarOptions | undefined { return this.options[kind]; }

  async ensureStarted(kind: LocalRankingSidecarKind): Promise<void> {
    const sidecar = this.sidecar(kind);
    if (!sidecar || this.started.has(kind)) return;
    this.started.add(kind);
    mkdirSync(sidecar.cacheDir, { recursive: true }); // llama-server downloads into LLAMA_CACHE when the model is absent
    const process = new ModelHostProcess(localRankingSidecarProcessOptions(sidecar), async () => {
      try { const response = await fetch(`http://127.0.0.1:${sidecar.port}/health`, { signal: AbortSignal.timeout(1_500) }); return response.ok; } catch { return false; }
    });
    this.processes.set(kind, process);
    try { await process.start(); } catch (error) { this.started.delete(kind); this.processes.delete(kind); await this.stop(); throw error; }
  }

  async start(): Promise<void> {
    for (const kind of ["embedding", "reranker"] as const) {
      if (this.sidecar(kind)?.eager) await this.ensureStarted(kind);
    }
  }

  async stop(): Promise<void> {
    for (const process of [...this.processes.values()].reverse()) await process.stop();
    this.processes.clear();
    this.started.clear();
  }
}
