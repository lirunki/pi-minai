import type { ModelReference } from "./contracts/common.js";
import { MinaiPiError } from "./errors.js";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "obsolete";

export type TaskNode = {
  id: string;
  planVersion: number;
  query: string;
  parentId?: string;
  dependencyIds: string[];
  guidanceId?: string;
  model?: ModelReference;
  artifactIds: string[];
  status: TaskStatus;
  result?: string;
  error?: string;
};

export type TaskGraph = {
  planVersion: number;
  nodes: TaskNode[];
};

export class GraphValidationError extends MinaiPiError {
  constructor(message: string) { super(message, "graph_validation"); this.name = "GraphValidationError"; }
}

export class SchedulerError extends MinaiPiError {
  constructor(message: string, code: "scheduler_cancelled" | "scheduler_failed") { super(message, code); this.name = "SchedulerError"; }
}

function clone<T>(value: T): T { return structuredClone(value); }

export function validateTaskGraph(graph: TaskGraph): void {
  if (!Number.isInteger(graph.planVersion) || graph.planVersion < 1) throw new GraphValidationError("planVersion must be a positive integer");
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id || ids.has(node.id)) throw new GraphValidationError(`Task IDs must be unique and non-empty: ${node.id}`);
    ids.add(node.id);
    if (node.planVersion !== graph.planVersion) throw new GraphValidationError(`Task ${node.id} has the wrong plan version`);
    if (!node.query.trim()) throw new GraphValidationError(`Task ${node.id} query must be non-empty`);
    if (node.parentId === node.id) throw new GraphValidationError(`Task ${node.id} cannot parent itself`);
  }
  for (const node of graph.nodes) {
    for (const dependency of node.dependencyIds) if (!ids.has(dependency)) throw new GraphValidationError(`Task ${node.id} depends on missing task ${dependency}`);
    if (node.parentId && !ids.has(node.parentId)) throw new GraphValidationError(`Task ${node.id} has missing parent ${node.parentId}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new GraphValidationError("Task graph contains a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencyIds) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of graph.nodes) visit(node.id);
}

export type TaskExecutionInput = { node: TaskNode; signal: AbortSignal };
export type TaskExecutionResult = { text: string; artifactIds?: string[] };
export type TaskExecutor = (input: TaskExecutionInput) => Promise<TaskExecutionResult>;

export type SchedulerResult = { graph: TaskGraph; results: Record<string, string> };

export class TaskScheduler {
  constructor(private readonly maxConcurrency = 2) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new SchedulerError("maxConcurrency must be positive", "scheduler_failed");
  }

  async run(input: TaskGraph, execute: TaskExecutor, signal?: AbortSignal): Promise<SchedulerResult> {
    validateTaskGraph(input);
    const graph = clone(input);
    const results: Record<string, string> = {};
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const active = new Map<string, Promise<void>>();
    const controllers = new Map<string, AbortController>();
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      for (const controller of controllers.values()) controller.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });

    const canRun = (node: TaskNode): boolean => node.status === "pending" && node.dependencyIds.every((id) => byId.get(id)?.status === "completed");
    const blockedByFailure = (node: TaskNode): boolean => node.status === "pending" && node.dependencyIds.some((id) => ["failed", "cancelled", "obsolete"].includes(byId.get(id)?.status ?? ""));

    const start = (node: TaskNode): void => {
      node.status = "running";
      const taskSignal = new AbortController();
      controllers.set(node.id, taskSignal);
      const promise = execute({ node: clone(node), signal: taskSignal.signal }).then((result) => {
        node.status = "completed";
        node.result = result.text;
        if (result.artifactIds) node.artifactIds = [...node.artifactIds, ...result.artifactIds];
        results[node.id] = result.text;
      }).catch((error: unknown) => {
        node.status = cancelled || signal?.aborted ? "cancelled" : "failed";
        node.error = error instanceof Error ? error.message : String(error);
      }).finally(() => { active.delete(node.id); controllers.delete(node.id); });
      active.set(node.id, promise);
    };

    try {
      while (true) {
        if (cancelled || signal?.aborted) {
          for (const node of graph.nodes) if (node.status === "pending") node.status = "cancelled";
          if (active.size === 0) break;
        }
        for (const node of graph.nodes) if (blockedByFailure(node)) node.status = "cancelled";
        while (!cancelled && active.size < this.maxConcurrency) {
          const next = graph.nodes.find(canRun);
          if (!next) break;
          start(next);
        }
        if (active.size === 0) {
          if (graph.nodes.some((node) => node.status === "pending")) throw new SchedulerError("Task graph cannot make further progress", "scheduler_failed");
          break;
        }
        await Promise.race(active.values());
      }
      if (signal?.aborted) throw new SchedulerError("Scheduler was cancelled", "scheduler_cancelled");
      return { graph: clone(graph), results };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
}

export type NewPlanRequest = {
  reason: string;
  discoveredFacts: string[];
  unresolvedQuestions: string[];
  obsoleteTaskIds: string[];
  preservedArtifactIds: string[];
  proposedTasks: Omit<TaskNode, "planVersion" | "status">[];
};

export class PlanStore {
  private current: TaskGraph;
  constructor(initial: TaskGraph) { validateTaskGraph(initial); this.current = clone(initial); }
  get(): TaskGraph { return clone(this.current); }

  applyNewPlan(request: NewPlanRequest): TaskGraph {
    if (!request.reason.trim()) throw new GraphValidationError("NEWPLAN reason must be non-empty");
    const obsolete = new Set(request.obsoleteTaskIds);
    const retained = this.current.nodes.map((node) => {
      const next = clone(node);
      if (obsolete.has(next.id)) next.status = "obsolete";
      else if (next.status === "running") next.status = "cancelled";
      return next;
    });
    const version = this.current.planVersion + 1;
    const replacement = request.proposedTasks.map((task) => ({ ...clone(task), planVersion: version, status: "pending" as const }));
    this.current = { planVersion: version, nodes: [...retained.map((node) => ({ ...node, planVersion: version })), ...replacement] };
    validateTaskGraph(this.current);
    return this.get();
  }
}
