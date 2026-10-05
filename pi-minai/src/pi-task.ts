import type { ModelReference } from "./contracts/common.js";
import { MinaiPiError } from "./errors.js";

export type PiTaskArtifactInput = {
  id: string;
  kind: string;
  label?: string;
  content: string;
};

export type PiTaskEnvelope = {
  requestId: string;
  taskId: string;
  planVersion?: number;
  query: string;
  guidanceId?: string;
  guidanceInstructions?: string;
  artifactInputs: PiTaskArtifactInput[];
  outputContract?: string;
};

export function renderPiTaskEnvelope(envelope: PiTaskEnvelope): string {
  const metadata = [
    `request_id: ${envelope.requestId}`,
    `task_id: ${envelope.taskId}`,
    ...(envelope.planVersion === undefined ? [] : [`plan_version: ${envelope.planVersion}`]),
    ...(envelope.guidanceId === undefined ? [] : [`guidance: ${envelope.guidanceId}`]),
  ].join("\n");
  const guidance = envelope.guidanceInstructions ? `\n\n## Guidance\n${envelope.guidanceInstructions}` : "";
  const artifacts = envelope.artifactInputs.length === 0 ? "" : `\n\n## Selected artifacts\n${envelope.artifactInputs.map((artifact) => [
    `### ${artifact.label ?? artifact.id} (${artifact.kind})`,
    `artifact_id: ${artifact.id}`,
    artifact.content,
  ].join("\n")).join("\n\n")}`;
  const output = envelope.outputContract ? `\n\n## Output contract\n${envelope.outputContract}` : "";
  return ["## MINAI task", metadata, `\n## Query\n${envelope.query}`, guidance, artifacts, output].join("\n").trim();
}

export type PiSessionEvent = { type: string; [key: string]: unknown };

export interface PiSessionLike {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export type PiTaskSessionFactory = (input: {
  model: ModelReference;
  signal?: AbortSignal;
}) => Promise<PiSessionLike>;

export type PiTaskEvent = {
  taskId: string;
  event: PiSessionEvent;
};

export type PiTaskResult = {
  taskId: string;
  text: string;
  events: PiSessionEvent[];
};

export class PiTaskError extends MinaiPiError {
  constructor(message: string, code: "pi_task_aborted" | "pi_task_session" | "pi_task_execution", options?: { cause?: unknown }) {
    super(message, code, options);
    this.name = "PiTaskError";
  }
}

function textDelta(event: PiSessionEvent): string | undefined {
  if (event.type !== "message_update") return undefined;
  const nested = event.assistantMessageEvent;
  if (typeof nested !== "object" || nested === null) return undefined;
  const delta = (nested as Record<string, unknown>).delta;
  return typeof delta === "string" ? delta : undefined;
}

export class PiTaskRunner {
  constructor(private readonly createSession: PiTaskSessionFactory) {}

  async run(envelope: PiTaskEnvelope, model: ModelReference, signal?: AbortSignal, onEvent?: (event: PiTaskEvent) => void): Promise<PiTaskResult> {
    if (signal?.aborted) throw new PiTaskError("Pi task was aborted before session creation", "pi_task_aborted");
    let session: PiSessionLike;
    try {
      session = await this.createSession({ model, signal });
    } catch (error) {
      throw new PiTaskError("Could not create Pi task session", "pi_task_session", { cause: error });
    }

    const events: PiSessionEvent[] = [];
    let text = "";
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
      onEvent?.({ taskId: envelope.taskId, event });
      text += textDelta(event) ?? "";
    });
    const abort = () => { void session.abort(); };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      if (signal?.aborted) throw new PiTaskError("Pi task was aborted", "pi_task_aborted");
      await session.prompt(renderPiTaskEnvelope(envelope));
      if (signal?.aborted) throw new PiTaskError("Pi task was aborted", "pi_task_aborted");
      return { taskId: envelope.taskId, text, events };
    } catch (error) {
      if (error instanceof PiTaskError) throw error;
      if (signal?.aborted) throw new PiTaskError("Pi task was aborted", "pi_task_aborted", { cause: error });
      throw new PiTaskError("Pi task execution failed", "pi_task_execution", { cause: error });
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  }
}
