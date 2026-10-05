/**
 * MINAI planning extension — a planning-board sibling of the todos
 * extension. The board holds the current plan (goal, subtasks with
 * dependencies and passalong context, preferred guidance/model/reasoning,
 * and a final aggregation step). Tools:
 *
 *   manage_plan  read/write the whole plan (schema validates structure)
 *   newplan      start a NEWPLAN, discarding any current plan
 *
 * The widget reuses the todo tree structure: ✓ completed, ◉ running,
 * ○ pending, ✗ failed, with dependency and preference hints.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type, Literal, Union } from "typebox";

function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string }) { return Union(values.map((value) => Literal(value)), options); }
import { PlanBoard, normalizePlanSteps, REASONING_LEVELS } from "../src/planning.js";
import type { Plan, PlanStep, PlanStepView, ReasoningLevel } from "../src/planning.js";

export type PlanningToolDetails = { operation: "read" | "write"; plan?: Plan; error?: string };

const STATUS_ICONS: Record<string, string> = { completed: "✓", running: "◉", pending: "○", failed: "✗" };
const WIDGET_ID = "minai-plan";
const board = new PlanBoard();
let currentCtx: ExtensionContext | undefined;

/** The shared planning board the orchestrator and tools both use. */
export function planningBoard(): PlanBoard { return board; }

/** Redraw the footer widget after any board mutation (tools or orchestrator). */
export function notifyPlanChanged(): void { if (currentCtx) updateWidget(currentCtx); }

const PlanStepSchema = Type.Object({
  query: Type.String({ description: "The instruction this subtask executes. Example: \"Analyze PostgreSQL for catalog and cart workloads\"." }),
  guidance: Type.Optional(Type.String({ description: "Preferred MINAI guidance id for this step, e.g. \"code_review\" or \"plan_query\"." })),
  model: Type.Optional(Type.String({ description: "Preferred model as provider/id, e.g. \"llama-serve/qwen2.5-0.5b\". Omit to use the routed backend." })),
  reasoning: Type.Optional(StringEnum(REASONING_LEVELS, { description: "Preferred reasoning level for this step: off|minimal|low|medium|high|xhigh|max." })),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Ids of steps this step depends on. Their results are passed along as context (passalong). Leave empty for independent steps." })),
  id: Type.Optional(Type.String({ description: "Stable step id used by dependsOn. Auto-numbered (\"1\", \"2\", …) when omitted." })),
});

const ManagePlanParams = Type.Object({
  operation: StringEnum(["write", "read"] as const, { description: "write: Replace entire plan with new content. read: Retrieve the current plan." }),
  goal: Type.Optional(Type.String({ description: "Overall goal of the plan (required for write)." })),
  steps: Type.Optional(Type.Array(PlanStepSchema, { description: "Complete array of subtasks (required for write). Include ALL steps — partial updates not supported." })),
});

const NewPlanParams = Type.Object({
  goal: Type.String({ description: "Overall goal the plan works toward." }),
  steps: Type.Array(PlanStepSchema, { description: "Subtasks of the new plan. Every prior plan is discarded." }),
});

const STEP_FIELDS = `Subtask shape:
{"query": "Analyze PostgreSQL workloads", "guidance": "code_review", "model": "llama-serve/qwen2.5-0.5b", "reasoning": "low", "dependsOn": ["1"], "id": "2"}
- query: the instruction executed for this step
- guidance: preferred guidance id (optional)
- model: preferred model provider/id (optional; default is the routed backend)
- reasoning: preferred reasoning level off|minimal|low|medium|high|xhigh|max (optional)
- dependsOn: ids of prerequisite steps; their results are passed along as context (passalong)
- id: stable id referenced by dependsOn; auto-numbered when omitted

Workflow: after all subtasks complete, an aggregation step combines their results into the final answer.`;

const MANAGE_PLAN_DESCRIPTION = `Manage the MINAI planning board: a goal plus ordered subtasks with dependencies, passalong context, and per-step guidance/model/reasoning preferences. The planner writes a plan before executing it; the orchestrator runs subtasks in dependency order, passes completed dependency results along, and executes the aggregation guidance once every subtask has settled.

${STEP_FIELDS}`;

const NEWPLAN_DESCRIPTION = `Start a NEWPLAN: discard the current planning board and install a fresh plan with all subtasks pending. Use whenever the request changes direction or the previous plan is obsolete.

${STEP_FIELDS}`;

function statusIcon(view: PlanStepView, theme: Theme): string {
  const icon = STATUS_ICONS[view.status] ?? "○";
  if (view.status === "completed") return theme.fg("success", icon);
  if (view.status === "running") return theme.fg("warning", icon.trim());
  if (view.status === "failed") return theme.fg("error", icon);
  return theme.fg("dim", icon);
}

function stepTitle(view: PlanStepView, theme: Theme): string {
  const hints: string[] = [];
  if (view.dependsOn.length) hints.push(`← ${view.dependsOn.join(",")}`);
  if (view.guidance) hints.push(`guide=${view.guidance}`);
  if (view.model) hints.push(`model=${view.model}`);
  if (view.reasoning) hints.push(`reasoning=${view.reasoning}`);
  const suffix = hints.length ? theme.fg("dim", `  ${hints.join(" · ")}`) : "";
  if (view.status === "completed") return theme.fg("dim", theme.strikethrough(view.query)) + suffix;
  if (view.status === "running") return theme.fg("warning", view.query) + suffix;
  if (view.status === "failed") return theme.fg("error", view.query) + (view.error ? theme.fg("dim", `  ${view.error}`) : "");
  return theme.fg("muted", view.query) + suffix;
}

export function planTreeLines(plan: { goal: string; steps: PlanStepView[]; aggregation?: { status: string; guidance?: string } } | undefined, theme: Theme): string[] {
  if (!plan) return [theme.fg("dim", "No plan. Use newplan or manage_plan write.")];
  const stats = plan.steps.reduce<Record<string, number>>((acc, step) => ({ ...acc, [step.status]: (acc[step.status] ?? 0) + 1 }), {});
  const lines = [theme.fg("accent", " MINAI Plan ") + theme.fg("muted", ` — ${stats.completed ?? 0}/${plan.steps.length} done · ${plan.goal}`)];
  for (const [index, step] of plan.steps.entries()) {
    lines.push(` ${statusIcon(step, theme)} ${theme.fg("accent", `${index + 1}.`)} ${stepTitle(step, theme)}`);
  }
  const aggregation = plan.aggregation ?? { status: "pending" };
  const aggregateIcon = aggregation.status === "completed" ? theme.fg("success", "✓") : aggregation.status === "running" ? theme.fg("warning", "◉") : theme.fg("dim", "○");
  const aggregateLabel = aggregation.status === "running" ? theme.fg("warning", "aggregating results") : theme.fg("dim", `aggregation${aggregation.guidance ? ` (${aggregation.guidance})` : ""}`);
  lines.push(` ${aggregateIcon} ${theme.fg("muted", "⇒")} ${aggregateLabel}`);
  return lines;
}

export function updateWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
    const current = board.read();
    const plan = current ? { goal: current.goal, steps: board.views(), aggregation: current.aggregation } : undefined;
    if (!plan) return { render: () => [theme.fg("dim", "No plan. Use newplan or manage_plan write.")], invalidate: () => {} };
    return {
      render(width: number) {
        const lines = planTreeLines(plan, theme);
        return lines.map((line) => line.length > width ? line.slice(0, width) : line);
      },
      invalidate: () => {},
    };
  });
}

export function clearWidget(ctx: ExtensionContext): void { ctx.ui.setWidget(WIDGET_ID, undefined); }

function planText(steps: PlanStep[]): string {
  const plan = board.read();
  return JSON.stringify({ ...(plan ? { id: plan.id, goal: plan.goal } : {}), steps: board.views(), aggregation: plan?.aggregation }, null, 2);
}

export function createPlanningTools() {
  return ([
    {
      name: "manage_plan",
      label: "Planning Board",
      description: MANAGE_PLAN_DESCRIPTION,
      parameters: ManagePlanParams,
      async execute(_toolCallId: string, params: { operation: "write" | "read"; goal?: string; steps?: unknown[] }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: PlanningToolDetails; isError?: boolean }> {
        if (params.operation === "read") {
          const steps = board.views();
          return { content: [{ type: "text" as const, text: steps.length ? planText(board.read()!.steps) : "No plan. Use newplan or manage_plan write." }], details: { operation: "read", plan: board.read() } };
        }
        const normalized = normalizePlanSteps(params.steps);
        const validation = board.write(params.goal ?? "", normalized);
        if (!validation.valid) {
          return { content: [{ type: "text" as const, text: `Validation failed:\n${validation.errors.map((error) => ` - ${error}`).join("\n")}` }], details: { operation: "write", plan: board.read(), error: validation.errors.join("; ") }, isError: true };
        }
        updateWidget(ctx);
        const stats = board.stats();
        return { content: [{ type: "text" as const, text: `Plan installed: ${stats.total} subtasks. The orchestrator runs them in dependency order and aggregates once every subtask settles.` }], details: { operation: "write", plan: board.read() } };
      },
    },
    {
      name: "newplan",
      label: "NEWPLAN",
      description: NEWPLAN_DESCRIPTION,
      parameters: NewPlanParams,
      async execute(_toolCallId: string, params: { goal: string; steps: unknown[] }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: PlanningToolDetails; isError?: boolean }> {
        const normalized = normalizePlanSteps(params.steps);
        const validation = board.write(params.goal, normalized);
        if (!validation.valid) {
          return { content: [{ type: "text" as const, text: `Validation failed:\n${validation.errors.map((error) => ` - ${error}`).join("\n")}` }], details: { operation: "write", plan: board.read(), error: validation.errors.join("; ") }, isError: true };
        }
        updateWidget(ctx);
        const stats = board.stats();
        return { content: [{ type: "text" as const, text: `NEWPLAN installed: ${stats.total} subtasks toward "${params.goal}". Prior plan discarded.` }], details: { operation: "write", plan: board.read() } };
      },
    },
  ] as const);
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => { currentCtx = ctx; if (board.read()) updateWidget(ctx); });
  pi.on("turn_start", async (_event, ctx) => { currentCtx = ctx; if (board.read()) updateWidget(ctx); });
  pi.on("session_shutdown", async () => { currentCtx = undefined; if (currentCtx) clearWidget(currentCtx); });
  const [managePlan, newPlan] = createPlanningTools();
  pi.registerTool(managePlan);
  pi.registerTool(newPlan);
  pi.registerCommand("plan", { description: "Show the current MINAI planning board", handler: async (_args, ctx) => { const plan = board.read(); if (!plan) { ctx.ui.notify("No plan. Use newplan or manage_plan write.", "info"); return; } updateWidget(ctx); const stats = board.stats(); ctx.ui.notify(`${stats.completed}/${stats.total} subtasks done${plan.aggregation?.status === "completed" ? "; aggregation complete" : ""}.`, "info"); } });
}
