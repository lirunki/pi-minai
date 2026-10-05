import { randomUUID } from "node:crypto";

export type HttpRunState = { model?: string; guidance?: string; thinking?: string; usage?: unknown; currentTask?: string; continuation?: string; output?: string; outputMode?: "text" | "thinking"; phase?: "guidance" | "model" | "planning" | "execution" | "aggregating" | "complete"; progress?: string; actions?: number; plan?: Array<{ id: string; query: string; status: "pending" | "running" | "completed" | "failed"; dependsOn?: string[]; guidance?: string; model?: string; reasoning?: string; error?: string }>; };
export type HttpRun = { id: string; controller: AbortController; startedAt: number; owner?: string; state: HttpRunState; cleanup?: () => void | Promise<void>; };

/** Shared lifecycle registry for Pi and local-host HTTP executions. */
export class HttpRunRegistry {
  private readonly runs = new Map<string, HttpRun>();
  private readonly continuations = new Map<string, { runId: string; owner?: string }>();
  private stopping = false;
  private registered = 0;
  private cancelled = 0;

  get size(): number { return this.runs.size; }
  list(): HttpRun[] { return [...this.runs.values()]; }
  get(id: string): HttpRun | undefined { return this.runs.get(id); }
  get isStopping(): boolean { return this.stopping; }
  metrics(): { active: number; registered: number; cancelled: number; stopping: boolean } { return { active: this.runs.size, registered: this.registered, cancelled: this.cancelled, stopping: this.stopping }; }
  update(id: string, patch: HttpRunState): boolean { const run = this.runs.get(id); if (!run) return false; run.state = { ...run.state, ...patch }; return true; }

  register(input: { id?: string; owner?: string; cleanup?: () => void | Promise<void> }): HttpRun {
    if (this.stopping) throw new Error("HTTP run registry is shutting down");
    const id = input.id ?? randomUUID();
    if (this.runs.has(id)) throw new Error(`HTTP run already exists: ${id}`);
    const run: HttpRun = { id, controller: new AbortController(), startedAt: Date.now(), state: {}, ...(input.owner === undefined ? {} : { owner: input.owner }), ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }) };
    this.runs.set(id, run); this.registered++;
    return run;
  }

  remove(id: string): boolean { return this.runs.delete(id); }
  bindContinuation(continuationId: string, runId: string, owner?: string): void { if (!this.runs.has(runId)) throw new Error(`HTTP run not found: ${runId}`); this.continuations.set(continuationId, { runId, ...(owner === undefined ? {} : { owner }) }); }
  ownsContinuation(continuationId: string, owner?: string): boolean { const binding = this.continuations.get(continuationId); return !!binding && (binding.owner === undefined || binding.owner === owner); }
  consumeContinuation(continuationId: string, owner?: string): boolean { if (!this.ownsContinuation(continuationId, owner)) return false; return this.continuations.delete(continuationId); }

  abort(id: string, owner?: string): boolean {
    const run = this.runs.get(id);
    if (!run || owner !== undefined && run.owner !== owner) return false;
    if (!run.controller.signal.aborted) { run.controller.abort(new Error("HTTP run cancelled")); this.cancelled++; }
    return true;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const runs = [...this.runs.values()];
    await Promise.all(runs.map(async (run) => {
      if (!run.controller.signal.aborted) { run.controller.abort(new Error("HTTP server shutting down")); this.cancelled++; }
      await run.cleanup?.();
      this.runs.delete(run.id);
    }));
  }
}
