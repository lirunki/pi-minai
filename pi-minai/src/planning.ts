/**
 * Planning board core shared by the planning extension tools and the
 * orchestration router. Modeled on the todo extension lifecycle
 * (pending → running → completed) extended with subtask dependencies,
 * passalong context, preferred guidance/model/reasoning per step, and a
 * final aggregation step that runs after every subtask settles.
 */

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type PlanStepStatus = "pending" | "running" | "completed" | "failed";

export type PlanStep = {
  /** Stable step id; auto-assigned ("1", "2", …) when omitted. */
  id: string;
  /** The instruction executed for this step. */
  query: string;
  /** Preferred guidance id to run this step with. */
  guidance?: string;
  /** Preferred model as "provider/id"; falls back to the routed backend. */
  model?: string;
  /** Preferred reasoning level for this step's invocation. */
  reasoning?: ReasoningLevel;
  /** Step ids this step depends on; their results are passed along as context. */
  dependsOn: string[];
  status: PlanStepStatus;
  result?: string;
  error?: string;
};

export type PlanAggregation = { status: PlanStepStatus; guidance?: string; result?: string };

export type Plan = { id: string; goal: string; steps: PlanStep[]; aggregation?: PlanAggregation };

export type PlanStepView = Pick<PlanStep, "id" | "query" | "status" | "dependsOn"> & Partial<Pick<PlanStep, "guidance" | "model" | "reasoning" | "error">>;

export type PlanStats = { total: number; completed: number; running: number; pending: number; failed: number };

export type PlanValidation = { valid: boolean; errors: string[] };

const VALID_STATUSES = new Set<string>(["pending", "running", "completed", "failed"]);

export function normalizePlanSteps(input: unknown): PlanStep[] {
  if (!Array.isArray(input)) return [];
  return input.map((raw, index) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [];
    const reasoning = typeof item.reasoning === "string" && (REASONING_LEVELS as readonly string[]).includes(item.reasoning) ? (item.reasoning as ReasoningLevel) : undefined;
    return {
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : String(index + 1),
      query: typeof item.query === "string" ? item.query.trim() : "",
      ...(typeof item.guidance === "string" && item.guidance.trim() ? { guidance: item.guidance.trim() } : {}),
      ...(typeof item.model === "string" && item.model.trim() ? { model: item.model.trim() } : {}),
      ...(reasoning ? { reasoning } : {}),
      dependsOn,
      status: VALID_STATUSES.has(String(item.status)) ? (item.status as PlanStepStatus) : "pending",
      ...(typeof item.result === "string" ? { result: item.result } : {}),
      ...(typeof item.error === "string" ? { error: item.error } : {}),
    };
  });
}

export class PlanBoard {
  private plan: Plan | undefined;
  private autoClearTimer: ReturnType<typeof setTimeout> | undefined;

  read(): Plan | undefined {
    return this.plan ? structuredClone(this.plan) : undefined;
  }

  /** Replace the current plan; ids are auto-assigned when omitted. */
  write(goal: string, steps: PlanStep[]): PlanValidation {
    const withIds = autoAssignIds(steps);
    const validation = this.validatePlan(withIds);
    if (!validation.valid) return validation;
    this.cancelAutoClear();
    this.plan = { id: randomPlanId(), goal: goal.trim() || "untitled goal", steps: withIds, aggregation: { status: "pending" } };
    return validation;
  }

  clear(): void {
    this.cancelAutoClear();
    this.plan = undefined;
  }

  stats(): PlanStats {
    const steps = this.plan?.steps ?? [];
    const count = (status: PlanStepStatus) => steps.filter((step) => step.status === status).length;
    return { total: steps.length, completed: count("completed"), running: count("running"), pending: count("pending"), failed: count("failed") };
  }

  step(id: string): PlanStep | undefined {
    return this.plan?.steps.find((step) => step.id === id);
  }

  /** Pending steps whose dependencies are all completed, in declaration order. */
  readySteps(): PlanStep[] {
    if (!this.plan) return [];
    return this.plan.steps.filter((step) => step.status === "pending" && step.dependsOn.every((dep) => this.step(dep)?.status === "completed"));
  }

  markRunning(id: string): void { this.setStatus(id, "running"); }
  markCompleted(id: string, result: string): void { const step = this.setStatus(id, "completed"); if (step) step.result = result; }
  markFailed(id: string, error: string): void { const step = this.setStatus(id, "failed"); if (step) step.error = error; }

  startAggregation(): void { if (this.plan) this.plan.aggregation = { ...(this.plan.aggregation ?? {}), status: "running" }; }
  completeAggregation(result: string): void {
    if (!this.plan) return;
    this.plan.aggregation = { ...(this.plan.aggregation ?? {}), status: "completed", result };
    if (this.plan.steps.length > 0 && this.plan.steps.every((step) => step.status === "completed")) this.scheduleAutoClear(() => this.clear());
  }

  /** Compact view snapshots for watch/UI rendering. */
  views(): PlanStepView[] {
    return (this.plan?.steps ?? []).map(({ id, query, status, dependsOn, guidance, model, reasoning, error }) => ({ id, query, status, dependsOn, ...(guidance ? { guidance } : {}), ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}), ...(error ? { error } : {}) }));
  }

  validatePlan(steps: PlanStep[]): PlanValidation {
    const errors: string[] = [];
    if (steps.length === 0) errors.push("plan must contain at least one step");
    const ids = new Set(steps.map((step) => step.id));
    if (ids.size !== steps.length) errors.push("step ids must be unique");
    for (const step of steps) {
      const prefix = `Step ${step.id}`;
      if (!step.query) errors.push(`${prefix}: missing or empty 'query'`);
      if (!VALID_STATUSES.has(step.status)) errors.push(`${prefix}: invalid status '${step.status}'`);
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) errors.push(`${prefix}: depends on unknown step '${dep}'`);
        else if (dep === step.id) errors.push(`${prefix}: depends on itself`);
      }
    }
    if (hasDependencyCycle(steps)) errors.push("plan dependencies contain a cycle");
    return { valid: errors.length === 0, errors };
  }

  private setStatus(id: string, status: PlanStepStatus): PlanStep | undefined {
    const step = this.step(id);
    if (step) step.status = status;
    return step;
  }

  private scheduleAutoClear(callback: () => void): void { this.autoClearTimer = setTimeout(() => { this.autoClearTimer = undefined; callback(); }, 2000); }
  private cancelAutoClear(): void { if (this.autoClearTimer) { clearTimeout(this.autoClearTimer); this.autoClearTimer = undefined; } }
}

function autoAssignIds(steps: PlanStep[]): PlanStep[] {
  const seen = new Set(steps.filter((step) => step.id).map((step) => step.id));
  let next = 1;
  return steps.map((step) => {
    if (step.id) return step;
    while (seen.has(String(next))) next += 1;
    seen.add(String(next));
    return { ...step, id: String(next) };
  });
}

function hasDependencyCycle(steps: PlanStep[]): boolean {
  const incoming = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    incoming.set(step.id, step.dependsOn.length);
    for (const dep of step.dependsOn) dependents.set(dep, [...(dependents.get(dep) ?? []), step.id]);
  }
  const queue = steps.filter((step) => (incoming.get(step.id) ?? 0) === 0).map((step) => step.id);
  let resolved = 0;
  while (queue.length) {
    const id = queue.pop()!;
    resolved += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const left = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, left);
      if (left === 0) queue.push(dependent);
    }
  }
  return resolved !== steps.length;
}

function randomPlanId(): string { return `plan-${Math.random().toString(36).slice(2, 10)}`; }
