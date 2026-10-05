import type { ModelReference } from "./contracts/common.js";
import type { HttpExecutionServices } from "./http-listener.js";
import type { NormalizedChatRequest, NormalizedChatResult, NormalizedChatStreamEvent } from "./http-protocol.js";
import type { ModelInvocation, ModelMessage } from "./model.js";
import type { AvailableModel } from "./contracts/common.js";
import type { ModelRequirement } from "./model.js";
import type { RegistryModelRouter } from "./registry-model-router.js";
import { LocalToolContinuationManager } from "./local-tool-continuation.js";
import { PlanBoard } from "./planning.js";
import type { PlanStep, PlanStepView, ReasoningLevel } from "./planning.js";

function invocation(request: NormalizedChatRequest, model: ModelReference): ModelInvocation { return { model, messages: request.messages.map(({ role, content }) => ({ role, content })), ...(request.tools === undefined ? {} : { tools: request.tools }), ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }), ...(request.thinking?.effort === "none" || request.thinking?.think === false ? { thinking: "off" as const } : request.thinking?.think && typeof request.thinking.think === "string" ? { thinking: request.thinking.think } : request.thinking?.effort ? { thinking: request.thinking.effort } : {}) }; }

export type PlanningProgress = { requestId?: string; phase: "guidance" | "model" | "planning" | "plan_ready" | "planning_failed" | "step_start" | "step_done" | "step_failed" | "aggregating"; message: string; steps?: PlanStepView[]; stepIndex?: number; model?: string; guidance?: string };
export type ModelExecutionRouterOptions = { classifierModel?: string; classifierMinConfidence?: number; requirements?: ModelRequirement; planning?: boolean; board?: PlanBoard; onProgress?: (progress: PlanningProgress) => void };

type StepResult = { step: PlanStep; result: string };

function planThinking(level: ReasoningLevel | undefined): "off" | "low" | "medium" | "high" {
  switch (level) {
    case "minimal": return "low";
    case "xhigh":
    case "max": return "high";
    case "off":
    case "low":
    case "medium":
    case "high": return level;
    default: return "off";
  }
}

function stepViews(board: PlanBoard): PlanStepView[] { return board.views(); }

export class ModelExecutionRouter implements HttpExecutionServices {
  readonly continuation: LocalToolContinuationManager;
  readonly board: PlanBoard;
  listModels(): AvailableModel[] { return this.models.candidates().map((reference) => this.models.model(reference)).filter((model): model is AvailableModel => model !== undefined); }
  constructor(private readonly models: RegistryModelRouter, private readonly options: ModelExecutionRouterOptions = {}) { this.board = options.board ?? new PlanBoard(); this.continuation = new LocalToolContinuationManager((reference) => models.host(reference), 60_000, async (request) => this.selectedModel(request)); }
  private async selectedModel(request: NormalizedChatRequest, signal?: AbortSignal): Promise<ModelReference> {
    this.options.onProgress?.({ requestId: request.requestId, phase: "guidance", message: "guidance selection: evaluating request", guidance: "plan_query" });
    const minaiAlias = request.model.provider === "minai" || (request.model.provider === "default" && request.model.id === "minai");
    if (!minaiAlias && request.model.id !== "auto" && request.model.provider !== "default") {
      this.options.onProgress?.({ requestId: request.requestId, phase: "model", message: `model selection: explicit ${request.model.provider}/${request.model.id}`, model: `${request.model.provider}/${request.model.id}` });
      return request.model;
    }
    const requirements = this.options.requirements ?? {
      ...(request.tools?.length ? { tools: true } : {}),
      ...(request.thinking ? { reasoning: true } : {}),
      ...(request.stream ? { streaming: true } : {}),
    };
    const selected = await this.models.select({
      query: request.messages.map((message) => message.content).join("\n"),
      ...(this.options.classifierModel === undefined ? {} : { classifierModel: this.options.classifierModel }),
      requestedModel: "auto",
      ...(this.options.classifierMinConfidence === undefined ? {} : { minConfidence: this.options.classifierMinConfidence }),
      requirements,
    }, signal);
    this.options.onProgress?.({ requestId: request.requestId, phase: "model", message: `model selection: auto chose ${selected.model.provider}/${selected.model.id} (${selected.source})`, model: `${selected.model.provider}/${selected.model.id}` });
    return selected.model;
  }

  private resolveModelRef(spec: string, fallback: ModelReference): ModelReference {
    const [provider, ...rest] = spec.split("/");
    const id = rest.join("/");
    const candidate = { provider, id };
    return this.models.candidates().some((available) => available.provider === candidate.provider && available.id === candidate.id) ? candidate : fallback;
  }

  /** Ask the planning guidance for a structured plan and install it on the board. */
  private async planBoard(request: NormalizedChatRequest, model: ModelReference, signal?: AbortSignal): Promise<boolean> {
    if (!this.options.planning) return false;
    this.options.onProgress?.({ requestId: request.requestId, phase: "planning", message: "planning guidance: requesting structured plan", guidance: "plan_query", model: `${model.provider}/${model.id}` });
    const planner = await this.models.host(model).invoke({ model, messages: [{ role: "user", content: [
      "You are the planning guidance. Decide whether the user request needs a multi-step plan, then return exactly one JSON object and nothing else.",
      "",
      "Decompose (return subtasks) when the request has ANY of:",
      "- multiple alternatives, options, or items to analyze (\"compare A, B, C\")",
      "- a sequence where one part feeds another (\"analyze, then recommend\")",
      "- multiple distinct questions or topics in one request",
      "- a request for synthesis, evaluation, or a recommendation based on analysis",
      "",
      "Answer directly (return {\"final\":...}) ONLY for simple factual questions, single-lookup requests, small talk, or pure math.",
      "",
      "Shapes:",
      "Direct: {\"final\":\"<the answer>\"}",
      "Plan: {\"goal\":\"<short goal>","\"subtasks\":[{\"query\":\"<imperative instruction>","\"dependsOn\":[\"1\"]}]}",
      "- goal: one line describing the overall objective",
      "- Each subtask must be self-contained and imperative.",
      "- dependsOn lists prerequisite subtask numbers whose results this step needs.",
      "- Dependencies must form a chain or tree, never a cycle.",
      "",
      "Example:",
      "Request: \"Compare Python and Rust for a CLI tool and recommend one for a startup.\"",
      "Answer: {\"goal\":\"Choose between Python and Rust for a startup CLI tool\",\"subtasks\":[{\"query\":\"Analyze Python for CLI development: ecosystem, speed, hiring\"},{\"query\":\"Analyze Rust for CLI development: ecosystem, speed, hiring\"},{\"query\":\"Compare failure modes and maintenance costs of both\",\"dependsOn\":[\"1\",\"2\"]},{\"query\":\"Recommend one for the startup and justify\",\"dependsOn\":[\"3\"]}]}",
      "",
      `User request:\n${request.messages.map((message) => `${message.role}: ${message.content}`).join("\n")}`,
    ].join("\n") }], thinking: "off" }, signal);
    const parsedPlan = this.parseSubtasks(planner.text);
    const subtasks = parsedPlan?.subtasks ?? [];
    if (subtasks.length === 0 && process.env.MINAI_FORCE_PLANNING === "1") {
      // Fallback for weak planners: force a canonical analysis→aggregate plan.
      const last = request.messages[request.messages.length - 1]?.content ?? "";
      const forced = await this.board.write("forced plan", [
        { id: "1", query: `Analyze the request in depth, covering all alternatives and angles:\n${last}`, dependsOn: [], status: "pending" },
        { id: "2", query: "Critique the analysis: identify gaps, risks, and counterarguments.", dependsOn: ["1"], status: "pending" },
      ]);
      if (forced.valid) {
        this.options.onProgress?.({ requestId: request.requestId, phase: "plan_ready", message: `forced planning produced ${this.board.stats().total} steps`, steps: stepViews(this.board) });
        return true;
      }
    }
    if (subtasks.length === 0) {
      this.options.onProgress?.({ requestId: request.requestId, phase: "plan_ready", message: "planning guidance selected a direct answer" });
      return false;
    }
    const validation = this.board.write(parsedPlan?.goal ?? "", subtasks.map((step) => ({ id: "", query: step.query, ...(step.guidance ? { guidance: step.guidance } : {}), ...(step.model ? { model: step.model } : {}), ...(step.reasoning ? { reasoning: step.reasoning } : {}), dependsOn: step.dependsOn, status: "pending" as const })));
    if (!validation.valid) {
      this.options.onProgress?.({ requestId: request.requestId, phase: "planning_failed", message: `planning guidance produced an invalid plan: ${validation.errors[0]}` });
      return false;
    }
    this.options.onProgress?.({ requestId: request.requestId, phase: "plan_ready", message: `planning guidance produced ${subtasks.length} steps`, steps: stepViews(this.board) });
    return true;
  }

  /** Extract subtasks from planner output, tolerating prose around the JSON. */
  private parseSubtasks(text: string): { goal?: string; subtasks: Array<{ query: string; guidance?: string; model?: string; reasoning?: ReasoningLevel; dependsOn: string[] }> } | undefined {
    for (const candidate of [text, ...(text.match(/\{[\s\S]*\}/g) ?? [])]) {
      try {
        const parsed = JSON.parse(candidate.trim()) as { final?: string; goal?: string; subtasks?: Array<{ query?: string; guidance?: string; model?: string; reasoning?: string; dependsOn?: string[] }> };
        const subtasks = (parsed.subtasks ?? []).map((step) => ({ query: String(step.query ?? ""), ...(step.guidance ? { guidance: step.guidance } : {}), ...(step.model ? { model: step.model } : {}), ...(step.reasoning ? { reasoning: step.reasoning as ReasoningLevel } : {}), dependsOn: (step.dependsOn ?? []).map(String) })).filter((step) => step.query);
        if (subtasks.length > 0) return { ...(parsed.goal ? { goal: parsed.goal } : {}), subtasks };
      } catch { /* try the next candidate */ }
    }
    return undefined;
  }

  private stepMessages(step: PlanStep, passalong: StepResult[]): ModelMessage[] {
    const context = passalong.length ? `Results from prerequisite steps:\n${passalong.map((entry) => `Step ${entry.step.id}${entry.step.guidance ? ` (${entry.step.guidance})` : ""}: ${entry.step.query}\n${entry.result}`).join("\n\n")}\n\n` : "";
    return [{ role: "user", content: `${context}Execute exactly this plan step (${step.id}) and return its result${step.guidance ? ` using the ${step.guidance} approach` : ""}:\n${step.query}` }];
  }

  private aggregateMessages(request: NormalizedChatRequest, results: StepResult[]): ModelMessage[] {
    const history = request.messages.slice(0, -1);
    const last = request.messages[request.messages.length - 1] ?? { role: "user" as const, content: "" };
    const body = results.length ? `The plan subtasks produced the following results.\n\n${results.map((entry) => `Step ${entry.step.id}${entry.step.guidance ? ` (${entry.step.guidance})` : ""}: ${entry.step.query}\n${entry.result}`).join("\n\n")}\n\n` : "The plan subtasks could not be executed; answer the request directly.\n\n";
    return [...history.map(({ role, content }) => ({ role, content })), { role: "user", content: `${body}Using the subtask results above, produce the final answer to this request:\n${last.content}` }];
  }

  private async *runBoardEvents(request: NormalizedChatRequest, fallbackModel: ModelReference, signal?: AbortSignal): AsyncGenerator<{ kind: "progress"; event: PlanningProgress } | { kind: "result"; results: StepResult[] }> {
    const results: StepResult[] = [];
    for (;;) {
      const ready = this.board.readySteps();
      if (ready.length === 0) break;
      for (const step of ready) {
        this.board.markRunning(step.id);
        this.options.onProgress?.({ requestId: request.requestId, phase: "step_start", steps: stepViews(this.board), message: `plan step ${step.id}: ${step.query}` });
        yield { kind: "progress", event: { requestId: request.requestId, phase: "step_start", steps: stepViews(this.board), message: `plan step ${step.id}: ${step.query}` } };
        const model = step.model ? this.resolveModelRef(step.model, fallbackModel) : fallbackModel;
        const passalong = results.filter((entry) => step.dependsOn.includes(entry.step.id));
        try {
          const response = await this.models.host(model).invoke({ model, messages: this.stepMessages(step, passalong), thinking: planThinking(step.reasoning) }, signal);
          results.push({ step: { ...step }, result: response.text });
          this.board.markCompleted(step.id, response.text);
          const event: PlanningProgress = { requestId: request.requestId, phase: "step_done", steps: stepViews(this.board), message: `plan step ${step.id} completed` };
          this.options.onProgress?.(event);
          yield { kind: "progress", event };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.board.markFailed(step.id, message);
          const event: PlanningProgress = { requestId: request.requestId, phase: "step_failed", steps: stepViews(this.board), message: `plan step ${step.id} failed: ${message}` };
          this.options.onProgress?.(event);
          yield { kind: "progress", event };
        }
      }
    }
    yield { kind: "result", results };
  }

  private async runBoard(request: NormalizedChatRequest, fallbackModel: ModelReference, signal?: AbortSignal): Promise<StepResult[]> {
    for await (const item of this.runBoardEvents(request, fallbackModel, signal)) if (item.kind === "result") return item.results;
    return [];
  }

  private finishResult(request: NormalizedChatRequest, model: ModelReference, result: { text: string; finishReason?: "stop" | "length" | "tool_call" | "error"; usage?: { inputTokens?: number; outputTokens?: number } }): NormalizedChatResult { const usage = result.usage; return { requestId: request.requestId, model, text: result.text, finishReason: result.finishReason === "tool_call" ? "tool_calls" : result.finishReason ?? "stop", ...(usage === undefined || (usage.inputTokens === undefined && usage.outputTokens === undefined) ? {} : { usage: { promptTokens: usage.inputTokens ?? 0, completionTokens: usage.outputTokens ?? 0 } }), ...(request.thinking === undefined ? {} : { effectiveThinking: request.thinking.effort === "none" || request.thinking.think === false ? "off" : request.thinking.effort ?? (typeof request.thinking.think === "string" ? request.thinking.think : undefined) }) }; }

  async complete(request: NormalizedChatRequest, signal?: AbortSignal): Promise<NormalizedChatResult> {
    const model = await this.selectedModel(request, signal);
    const planned = await this.planBoard(request, model, signal);
    if (!planned) return this.finishResult(request, model, await this.models.host(model).invoke(invocation(request, model), signal));
    const results = await this.runBoard(request, model, signal);
    this.board.startAggregation();
    const completed = results.length;
    const total = this.board.stats().total;
    this.options.onProgress?.({ requestId: request.requestId, phase: "aggregating", steps: stepViews(this.board), message: completed ? `aggregating ${completed}/${total} plan step results` : "aggregating: no plan steps succeeded; answering directly" });
    const aggregated = await this.models.host(model).invoke({ model, messages: this.aggregateMessages(request, results), thinking: "off" }, signal);
    this.board.completeAggregation(aggregated.text);
    this.options.onProgress?.({ requestId: request.requestId, phase: "plan_ready", steps: stepViews(this.board), message: "aggregation complete" });
    return this.finishResult(request, model, aggregated);
  }

  async *stream(request: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<NormalizedChatStreamEvent> {
    const model = await this.selectedModel(request, signal);
    const planned = await this.planBoard(request, model, signal);
    if (!planned) {
      let text = "";
      for await (const event of this.models.host(model).stream(invocation(request, model), signal)) { if (event.type === "delta") { text += event.text; yield { type: "text_delta", requestId: request.requestId, model, delta: event.text }; } else if (event.type === "thinking_delta") yield { type: "thinking_delta", requestId: request.requestId, model, delta: event.text }; else if (event.type === "tool_call") continue; else yield { type: "done", result: { requestId: request.requestId, model, text, finishReason: event.result.finishReason === "tool_call" ? "tool_calls" : event.result.finishReason ?? "stop", ...(event.result.usage === undefined ? {} : { usage: { promptTokens: event.result.usage.inputTokens, completionTokens: event.result.usage.outputTokens } }) } }; }
      return;
    }
    yield { type: "thinking_delta", requestId: request.requestId, model, delta: `[plan] executing ${this.board.stats().total}-step plan\n` };
    const results: StepResult[] = [];
    for await (const item of this.runBoardEvents(request, model, signal)) {
      if (item.kind === "result") { results.push(...item.results); continue; }
      const event = item.event;
      if (event.phase === "step_start") yield { type: "thinking_delta", requestId: request.requestId, model, delta: `[plan step ${event.message.slice("plan step ".length)}] started\n` };
      else if (event.phase === "step_done") {
        const entry = results[results.length - 1];
        if (entry) yield { type: "thinking_delta", requestId: request.requestId, model, delta: `[plan step ${entry.step.id}] ${entry.step.query}\n${entry.result}\n\n` };
      } else if (event.phase === "step_failed") yield { type: "thinking_delta", requestId: request.requestId, model, delta: `[${event.message}]\n` };
    }
    this.board.startAggregation();
    const completed = results.length;
    const total = this.board.stats().total;
    this.options.onProgress?.({ requestId: request.requestId, phase: "aggregating", steps: stepViews(this.board), message: completed ? `aggregating ${completed}/${total} plan step results` : "aggregating: no plan steps succeeded; answering directly" });
    let text = "";
    for await (const event of this.models.host(model).stream({ model, messages: this.aggregateMessages(request, results), thinking: "off" }, signal)) { if (event.type === "delta") { text += event.text; yield { type: "text_delta", requestId: request.requestId, model, delta: event.text }; } else if (event.type === "thinking_delta") yield { type: "thinking_delta", requestId: request.requestId, model, delta: event.text }; else if (event.type === "tool_call") continue; else yield { type: "done", result: { requestId: request.requestId, model, text, finishReason: event.result.finishReason === "tool_call" ? "tool_calls" : event.result.finishReason ?? "stop", ...(event.result.usage === undefined ? {} : { usage: { promptTokens: event.result.usage.inputTokens, completionTokens: event.result.usage.outputTokens } }) } }; }
    this.board.completeAggregation(text);
  }
}
