import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { MinaiHttpHandler, startMinaiHttpServer, type MinaiHttpServer, type HttpExecutionServices, type HttpListenerOptions } from "../src/http-listener.js";
import { HttpRequestSessionRegistry, type RequestSessionFactory } from "../src/http-runtime.js";
import { createPiHttpExecutionServices } from "../src/http-execution.js";
import { createPiSdkRequestSessionFactory } from "../src/pi-sdk-session.js";
import { ModelExecutionRouter } from "../src/model-execution-router.js";
import type { RegistryModelRouter } from "../src/registry-model-router.js";
import type { SystemOneService } from "../src/contracts/system-one.js";
import { ModelHostSystemOneService } from "../src/model-host-system-one.js";
import { OpenAiCompatibleEmbeddingService, type TextEmbeddingService } from "../src/model-embeddings.js";
import { LocalRankingHosts, loadLocalRankingHostsOptions } from "../src/local-ranking-host.js";
import { FileModelHostRegistry } from "../src/file-host-registry.js";
import { LocalHostRuntime } from "../src/local-host-runtime.js";
import { getLoadedGuidanceCatalog, loadProjectGuidances } from "./guidance.js";
import { HttpRunRegistry } from "../src/http-runs.js";
import { notifyPlanChanged, planningBoard } from "./planning.js";
import { RegistryModelRouter as FileRegistryModelRouter } from "../src/registry-model-router.js";

export type HttpExtensionOptions = { port: number; host?: string; listener?: HttpListenerOptions; services?: HttpExecutionServices; mode?: "pi" | "local-host"; modelRouter?: RegistryModelRouter; registryPath?: string; classifierModel?: string; classifierMinConfidence?: number; systemOne?: SystemOneService; embeddingService?: TextEmbeddingService; embeddingMinConfidence?: number; embeddingTemperature?: number; planning?: boolean; maxConcurrentPerHost?: number; refreshHostHealth?: boolean; createRequestSession?: RequestSessionFactory; rankingHosts?: LocalRankingHosts };

export class HttpExtensionRuntime {
  private server?: MinaiHttpServer;
  readonly sessions?: HttpRequestSessionRegistry;
  readonly runs = new HttpRunRegistry();
  private services?: HttpExecutionServices;
  private localHosts?: LocalHostRuntime;
  constructor(private readonly options: HttpExtensionOptions) {
    if (options.modelRouter && options.mode !== "pi") this.services = options.services ?? new ModelExecutionRouter(options.modelRouter, { classifierModel: options.classifierModel, classifierMinConfidence: options.classifierMinConfidence });
    else if (options.services) this.services = options.services;
    else if (options.registryPath) { /* Load lazily in start(). */ }
    else { if (!options.createRequestSession) throw new Error("Pi mode requires createRequestSession"); this.sessions = new HttpRequestSessionRegistry(options.createRequestSession); this.services = createPiHttpExecutionServices({ createSession: options.createRequestSession }); }
  }
  async start(): Promise<MinaiHttpServer> {
    if (this.server) return this.server;
    if (!this.services && this.options.registryPath) {
      const registry = await FileModelHostRegistry.load(this.options.registryPath);
      this.localHosts = new LocalHostRuntime(registry, { maxConcurrentPerHost: this.options.maxConcurrentPerHost });
      await this.localHosts.start();
      if (this.options.refreshHostHealth !== false) await this.localHosts.refreshHealth();
      const defaultClassifier = this.localHosts.catalog().list()[0];
      const classifierModel = this.options.classifierModel ?? (defaultClassifier ? `${defaultClassifier.provider}/${defaultClassifier.id}` : undefined);
      const classifierReference = classifierModel ? parseModelReference(classifierModel) : undefined;
      if (classifierReference && !this.options.systemOne && !registry.getModel(classifierReference)) throw new Error(`MINAI classifier model is not present in the model registry: ${classifierModel}`);
      const systemOne = this.options.systemOne ?? (classifierReference ? new ModelHostSystemOneService(classifierReference, (reference) => this.localHosts!.host(reference)) : undefined);
      const selectorOptions = {
        ...(this.options.embeddingService ? { embeddingService: this.options.embeddingService } : {}),
        ...(this.options.embeddingMinConfidence === undefined ? {} : { embeddingMinConfidence: this.options.embeddingMinConfidence }),
        ...(this.options.embeddingTemperature === undefined ? {} : { embeddingTemperature: this.options.embeddingTemperature }),
      };
      const modelRouter = new FileRegistryModelRouter(registry, systemOne, this.localHosts, selectorOptions);
      this.services = new ModelExecutionRouter(modelRouter, { classifierModel, classifierMinConfidence: this.options.classifierMinConfidence, planning: this.options.planning, board: planningBoard(), onProgress: (progress) => { if (progress.requestId) this.runs.update(progress.requestId, { phase: progress.phase === "planning_failed" || progress.phase === "plan_ready" ? "planning" : progress.phase === "aggregating" ? "aggregating" : progress.phase === "step_start" || progress.phase === "step_done" || progress.phase === "step_failed" ? "execution" : progress.phase === "model" ? "model" : progress.phase === "guidance" ? "guidance" : "planning", progress: progress.message, ...(progress.model ? { model: progress.model } : {}), ...(progress.guidance ? { guidance: progress.guidance } : {}), ...(progress.steps ? { plan: progress.steps } : {}) }); if (progress.phase === "plan_ready" || progress.phase === "step_start" || progress.phase === "step_done" || progress.phase === "step_failed" || progress.phase === "aggregating") notifyPlanChanged(); } });
    }
    if (!this.services) throw new Error("HTTP execution services are not configured");
    await this.options.rankingHosts?.start();
    try { this.server = await startMinaiHttpServer(new MinaiHttpHandler(this.services, this.options.listener, this.runs), { host: this.options.host, port: this.options.port }); return this.server; } catch (error) { await this.options.rankingHosts?.stop(); await this.localHosts?.stop(); this.localHosts = undefined; throw error; }
  }
  get isStarted(): boolean { return this.server !== undefined; }
  get address(): string | object | null { return this.server?.address() ?? null; }
  async stop(): Promise<void> { await this.runs.shutdown(); await this.sessions?.shutdown(); await this.server?.close(); await this.localHosts?.stop(); await this.options.rankingHosts?.stop(); this.server = undefined; }
}

function listenerOptions(): HttpListenerOptions { return process.env.MINAI_HTTP_TOKEN === undefined ? {} : { bearerToken: process.env.MINAI_HTTP_TOKEN }; }
function parseModelReference(value: string): { provider: string; id: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`Model reference must use provider/model format: ${value}`);
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}
function numericEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}
function probabilityEnvironment(name: string, fallback: number): number {
  const parsed = numericEnvironment(name, fallback);
  if (parsed < 0 || parsed > 1) throw new Error(`${name} must be between 0 and 1`);
  return parsed;
}
function positiveEnvironment(name: string, fallback: number): number {
  const parsed = numericEnvironment(name, fallback);
  if (parsed <= 0) throw new Error(`${name} must be greater than 0`);
  return parsed;
}
function configuredEmbeddingService(rankingHosts?: LocalRankingHosts): TextEmbeddingService | undefined {
  const baseUrl = process.env.MINAI_EMBEDDING_BASE_URL;
  if (baseUrl !== undefined) {
    const model = process.env.MINAI_EMBEDDING_MODEL;
    if (!model) throw new Error("MINAI_EMBEDDING_BASE_URL requires MINAI_EMBEDDING_MODEL");
    return new OpenAiCompatibleEmbeddingService({ baseUrl, model, ...(process.env.MINAI_EMBEDDING_API_KEY ? { apiKey: process.env.MINAI_EMBEDDING_API_KEY } : {}) });
  }
  if (rankingHosts?.embeddingBaseUrl) return rankingHosts.embedding(); // lazy: sidecar starts (and downloads) on first embed
  return undefined;
}
/** Sidecar config from MINAI_RANKING_CONFIG or the model registry's "ranking" key. */
function configuredRankingHosts(): LocalRankingHosts | undefined {
  const explicit = process.env.MINAI_RANKING_CONFIG;
  const configPath = explicit ?? process.env.MINAI_MODEL_REGISTRY ?? process.env.MINAI_REGISTRY_PATH;
  if (configPath === undefined) return undefined;
  if (explicit !== undefined && !existsSync(configPath)) throw new Error(`MINAI_RANKING_CONFIG file not found: ${configPath}`);
  const options = loadLocalRankingHostsOptions(configPath);
  return options ? new LocalRankingHosts(options) : undefined;
}

function configuredMinaiRuntime(port = Number(process.env.MINAI_HTTP_PORT ?? 8788)): HttpExtensionRuntime {
  const registryPath = process.env.MINAI_MODEL_REGISTRY ?? process.env.MINAI_REGISTRY_PATH;
  const rankingHosts = configuredRankingHosts();
  return new HttpExtensionRuntime({ port, host: process.env.MINAI_HTTP_HOST ?? "127.0.0.1", mode: "local-host", ...(registryPath === undefined ? {} : { registryPath }), listener: listenerOptions(), classifierModel: process.env.MINAI_CLASSIFIER_MODEL, classifierMinConfidence: probabilityEnvironment("MINAI_CLASSIFIER_MIN_CONFIDENCE", 0.65), embeddingService: configuredEmbeddingService(rankingHosts), embeddingMinConfidence: probabilityEnvironment("MINAI_EMBEDDING_MIN_CONFIDENCE", 0.75), embeddingTemperature: positiveEnvironment("MINAI_EMBEDDING_TEMPERATURE", 0.1), planning: process.env.MINAI_PLANNING !== "0", maxConcurrentPerHost: Number(process.env.MINAI_MAX_CONCURRENT_PER_HOST ?? 1), ...(rankingHosts ? { rankingHosts } : {}) });
}
function configuredPiRuntime(ctx: ExtensionCommandContext, getCurrentModel: () => NonNullable<ExtensionCommandContext["model"]> | undefined, port = Number(process.env.MINAI_PI_HTTP_PORT ?? 8787)): HttpExtensionRuntime {
  const initial = getCurrentModel() ?? ctx.model;
  if (!initial) throw new Error("Pi has no current model for the pidev endpoint");
  const createRequestSession = createPiSdkRequestSessionFactory({
    cwd: ctx.cwd,
    modelReference: { provider: initial.provider, id: initial.id },
    // Resolve the backend at request time. Changing Pi's model while pidev is
    // running changes the backend used by the next request; no model is held
    // permanently by the HTTP endpoint.
    resolveModel: async () => getCurrentModel() ?? initial,
  });
  return new HttpExtensionRuntime({ port, host: process.env.MINAI_PI_HTTP_HOST ?? "127.0.0.1", mode: "pi", createRequestSession, listener: listenerOptions() });
}

function portOf(address: string | object | null, fallback: number): number {
  return typeof address === "object" && address !== null && "port" in address ? (address as { port: number }).port : fallback;
}

/** Register an OpenAI-compatible Pi model for one of the two MINAI services. */
export function registerHttpProvider(pi: ExtensionAPI, provider: "pidev" | "minai", address: string | object | null, contextWindow = 32768): void {
  const isPi = provider === "pidev";
  const port = portOf(address, Number(process.env[isPi ? "MINAI_PI_HTTP_PORT" : "MINAI_HTTP_PORT"] ?? (isPi ? 8787 : 8788)));
  const token = process.env.MINAI_HTTP_TOKEN;
  pi.registerProvider(provider, {
    name: isPi ? "Pi Dev HTTP" : "MINAI HTTP",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    apiKey: token ?? "local-minai",
    ...(token === undefined ? {} : { authHeader: true }),
    models: [{ id: provider, name: isPi ? "Pi Dev" : "MINAI", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 1024 }],
  });
}

/** Backward-compatible MINAI provider registration helper. */
export function registerMinaiProvider(pi: ExtensionAPI, address: string | object | null): void { registerHttpProvider(pi, "minai", address); }

export default function httpExtension(pi: ExtensionAPI): void {
  let piRuntime: HttpExtensionRuntime | undefined;
  let minaiRuntime: HttpExtensionRuntime | undefined;
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  const registered = new Set<"pidev" | "minai">();
  let watchGeneration = 0;
  let currentPiModel: ExtensionCommandContext["model"];
  const getCurrentModel = () => currentPiModel;
  pi.on("model_select", (event) => { currentPiModel = event.model; });
  const stopWatch = () => { if (watchTimer) clearInterval(watchTimer); watchTimer = undefined; watchGeneration++; };
  const formatRuns = () => [piRuntime, minaiRuntime].flatMap((runtime) => (runtime?.runs.list() ?? []).map((run) => ({ id: run.id, owner: run.owner, startedAt: run.startedAt, ...run.state })));
  const compactRuns = () => formatRuns().map((run) => {
    const age = `${Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000))}s`;
    const model = run.model ?? "model?";
    const guidance = run.guidance ? ` guide=${run.guidance}` : " guide=auto";
    const progress = run.progress ?? run.currentTask ?? "working";
    const output = run.output ? ` out=${run.output.replace(/\\s+/g, " ").slice(-100)}` : "";
    // Plan tree reuses the planning-extension widget structure (todo icon
    // convention), colored with ANSI like the TUI theme: green completed,
    // yellow in-flight/aggregating, red failed, dim pending.
    const noColor = process.env.NO_COLOR !== undefined || !process.env.TERM || process.env.TERM === "dumb";
    const c = (code: string, text: string) => noColor ? text : `\u001b[${code}m${text}\u001b[0m`;
    const dim = (text: string) => c("2", text);
    const marks: Record<string, { glyph: string; color: string }> = { completed: { glyph: "✓", color: "32" }, running: { glyph: "◉", color: "33" }, pending: { glyph: "○", color: "2" }, failed: { glyph: "✗", color: "31" } };
    const phaseColors: Record<string, string> = { guidance: "2", model: "2", planning: "35", execution: "36", aggregating: "33", complete: "32" };
    const plan = run.plan ?? [];
    const done = plan.filter((step) => step.status === "completed").length;
    const summary = plan.length ? ` · ${c("33", `plan ${done}/${plan.length}`)}` : "";
    const phaseTag = c(phaseColors[run.phase ?? "execution"] ?? "0", run.phase ?? "running");
    const tree = plan.map((step) => {
      const hints: string[] = [];
      if (step.dependsOn?.length) hints.push(`← ${step.dependsOn.join(",")}`);
      if (step.guidance) hints.push(`guide=${step.guidance}`);
      if (step.model) hints.push(`model=${step.model}`);
      if (step.reasoning) hints.push(`reasoning=${step.reasoning}`);
      const suffix = hints.length ? dim(`  ${hints.join(" · ")}`) : "";
      const mark = marks[step.status] ?? marks.pending!;
      const title = step.status === "completed" ? dim(`~${step.query}~`) : step.status === "running" ? c("33", step.query) : step.status === "failed" ? c("31", step.query) : step.query;
      return ` ${c(mark.color, mark.glyph)} ${title.slice(0, 96)}${suffix}`;
    });
    const aggregating = run.phase === "aggregating" ? [c("33", " ⇒ aggregating")] : [];
    return [`${dim(run.id.slice(0, 8))} ${dim(age)} ${phaseTag} ${model}${guidance}${summary} · ${progress}${output}`, ...tree, ...aggregating].join("\n");
  });
  const start = async (kind: "pidev" | "minai", ctx: ExtensionCommandContext): Promise<void> => {
    const isPi = kind === "pidev";
    let runtime = isPi ? (piRuntime ??= configuredPiRuntime(ctx, getCurrentModel)) : (minaiRuntime ??= configuredMinaiRuntime());
    let server: MinaiHttpServer;
    try { server = await runtime.start(); } catch (error) {
      const addressInUse = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
      if (!addressInUse || process.env.MINAI_HTTP_STRICT_PORT === "1") throw error;
      runtime = isPi ? (piRuntime = configuredPiRuntime(ctx, getCurrentModel, 0)) : (minaiRuntime = configuredMinaiRuntime(0));
      server = await runtime.start();
      ctx.ui.notify(`${kind} default port was busy; using an available local port`, "warning");
    }
    if (!registered.has(kind)) { registerHttpProvider(pi, kind, server.address(), isPi ? (ctx.model?.contextWindow ?? 32768) : 8192); registered.add(kind); }
    ctx.ui.notify(`${kind} HTTP started at ${server.address()} (Pi model: ${kind}/${kind})`, "info");
  };
  const stop = async (kind: "pidev" | "minai"): Promise<void> => { const runtime = kind === "pidev" ? piRuntime : minaiRuntime; await runtime?.stop(); if (registered.delete(kind)) pi.unregisterProvider(kind); };
  pi.registerCommand("minai", { description: "Manage Pi dev and MINAI HTTP endpoints", handler: async (args, ctx) => {
 currentPiModel = ctx.model;
    const command = args.trim().split(/\s+/)[0] ?? "help";
    if (command !== "watch" && command !== "stop_watch") stopWatch();
    if (command === "start_http") { await start("pidev", ctx); return; }
    if (command === "stop_http") { await stop("pidev"); ctx.ui.notify("Pi dev HTTP stopped", "info"); return; }
    if (command === "start") { await start("minai", ctx); return; }
    if (command === "stop") { await stop("minai"); ctx.ui.notify("MINAI HTTP and managed hosts stopped", "info"); return; }
    if (command === "status") { ctx.ui.notify(JSON.stringify({ pidev: piRuntime ? { started: piRuntime.isStarted, address: piRuntime.address, runs: piRuntime.runs.metrics() } : null, minai: minaiRuntime ? { started: minaiRuntime.isStarted, address: minaiRuntime.address, runs: minaiRuntime.runs.metrics() } : null }), "info"); return; }
    if (command === "runs") { ctx.ui.notify(JSON.stringify(formatRuns(), null, 2), "info"); return; }
    if (command === "watch") { stopWatch(); const generation = watchGeneration; const emit = () => { if (generation === watchGeneration) { const runs = compactRuns(); if (runs.length) ctx.ui.notify(runs.join("\n"), "info"); } }; emit(); watchTimer = setInterval(emit, 1000); ctx.ui.notify("MINAI run watch active (compact; /minai runs shows JSON)", "info"); return; }
    if (command === "stop_watch") { stopWatch(); ctx.ui.notify("MINAI run watch stopped", "info"); return; }
    if (command === "models") { const runtime = minaiRuntime ?? piRuntime; if (!runtime?.isStarted) { ctx.ui.notify("Start an endpoint first: /minai start_http or /minai start", "warning"); return; } const address = runtime.address as { port: number }; const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`); ctx.ui.notify(JSON.stringify(await response.json()), "info"); return; }
    if (command === "thinking") { ctx.ui.notify(JSON.stringify(formatRuns().map((run) => ({ id: run.id, model: run.model, thinking: run.thinking, outputMode: run.outputMode, output: run.output })), null, 2), "info"); return; }
    if (command === "guidances") { try { const loaded = getLoadedGuidanceCatalog() ?? await loadProjectGuidances(); ctx.ui.notify(loaded.list().map((guidance) => `${guidance.id}: ${guidance.description}`).join("\n"), "info"); } catch { ctx.ui.notify("Guidance directory is unavailable", "warning"); } return; }
    ctx.ui.notify("Usage: /minai start_http | stop_http | start | stop | status | runs | watch | stop_watch | thinking | models | guidances", "info");
  } });
  pi.on("session_shutdown", async () => { stopWatch(); await stop("pidev"); await stop("minai"); piRuntime = undefined; minaiRuntime = undefined; });
}
