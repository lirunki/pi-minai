import { randomUUID } from "node:crypto";
import type { PiSessionLike } from "./pi-task.js";
import type { ExternalToolMap } from "./http-continuation.js";
import type { HttpToolDefinition } from "./http-protocol.js";
import type { ModelReference } from "./contracts/common.js";

export type HttpRequestSession = { id: string; session: PiSessionLike; abortController: AbortController; startedAt: number };
export type RequestSessionFactory = (input: { id: string; signal: AbortSignal; model?: ModelReference; thinking?: "off" | "low" | "medium" | "high"; maxOutputTokens?: number; externalTools?: ExternalToolMap; externalToolDefinitions?: HttpToolDefinition[] }) => Promise<PiSessionLike>;

/** Owns one Pi session per HTTP run; never shares the interactive Pi session. */
export class HttpRequestSessionRegistry {
  private readonly runs = new Map<string, HttpRequestSession>();
  private shuttingDown = false;

  constructor(private readonly createSession: RequestSessionFactory) {}
  get size(): number { return this.runs.size; }
  get ids(): string[] { return [...this.runs.keys()]; }

  async run<T>(operation: (run: HttpRequestSession) => Promise<T>, id = randomUUID()): Promise<T> {
    if (this.shuttingDown) throw new Error("HTTP session registry is shutting down");
    const abortController = new AbortController();
    const session = await this.createSession({ id, signal: abortController.signal });
    if (this.shuttingDown) { abortController.abort(); session.dispose(); throw new Error("HTTP session registry is shutting down"); }
    const run = { id, session, abortController, startedAt: Date.now() };
    this.runs.set(id, run);
    try { return await operation(run); }
    finally { this.remove(id, run); }
  }

  abort(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    run.abortController.abort(new Error("HTTP request cancelled"));
    void run.session.abort();
    return true;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const runs = [...this.runs.values()];
    await Promise.all(runs.map(async (run) => { this.runs.delete(run.id); run.abortController.abort(new Error("Pi session shutting down")); await run.session.abort().catch(() => undefined); run.session.dispose(); }));
  }

  private remove(id: string, run: HttpRequestSession): void {
    if (this.runs.get(id) !== run) return;
    this.runs.delete(id);
    run.session.dispose();
  }
}
