import { createAgentSession, SessionManager, type CreateAgentSessionOptions, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { ExternalToolMap } from "./http-continuation.js";
import type { HttpToolDefinition } from "./http-protocol.js";
import type { ModelReference } from "./contracts/common.js";
import type { PiSessionLike } from "./pi-task.js";
import type { RequestSessionFactory } from "./http-runtime.js";

export type PiSdkSessionCreator = (options: CreateAgentSessionOptions) => Promise<{ session: PiSessionLike }>;
export type PiSdkRequestSessionOptions = Omit<CreateAgentSessionOptions, "model" | "customTools"> & {
  modelReference: ModelReference;
  resolveModel: (reference: ModelReference) => Promise<NonNullable<CreateAgentSessionOptions["model"]>>;
  customTools?: (input: { requestId: string; signal: AbortSignal }) => ToolDefinition[];
};

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function externalPiTools(definitions: HttpToolDefinition[] | undefined, handlers: ExternalToolMap | undefined): ToolDefinition[] {
  if (!definitions?.length) return [];
  return definitions.map((tool) => {
    const handler = handlers?.[tool.name];
    if (!handler) throw new Error(`No external handler registered for caller tool: ${tool.name}`);
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description ?? `Caller-provided tool ${tool.name}`,
      parameters: Type.Unsafe(tool.parameters as TSchema),
      execute: async (toolCallId, args) => {
        const result = await handler({ toolCallId, name: tool.name, arguments: args });
        return { content: [{ type: "text", text: toolResultText(result) }], details: result };
      },
    } as ToolDefinition;
  });
}

/** Creates a fresh SDK AgentSession for every HTTP request. */
export function createPiSdkRequestSessionFactory(options: PiSdkRequestSessionOptions, creator: PiSdkSessionCreator = createAgentSession): RequestSessionFactory {
  return async ({ id, signal, model: requestedModel, maxOutputTokens, externalTools, externalToolDefinitions }) => {
    if (signal.aborted) throw new Error("HTTP request was aborted");
    const resolved = requestedModel ? await options.resolveModel(requestedModel) : await options.resolveModel(options.modelReference);
    const callerTools = externalPiTools(externalToolDefinitions, externalTools);
    const customTools = [...(options.customTools?.({ requestId: id, signal }) ?? []), ...callerTools];
    // Per-request output cap: clone the model config with maxTokens overridden.
    const model = maxOutputTokens === undefined ? resolved : { ...resolved, maxTokens: Math.min(resolved.maxTokens, maxOutputTokens) };
    const result = await creator({
      cwd: options.cwd,
      agentDir: options.agentDir,
      modelRuntime: options.modelRuntime,
      model,
      thinkingLevel: options.thinkingLevel,
      scopedModels: options.scopedModels,
      noTools: options.noTools,
      tools: options.tools,
      excludeTools: options.excludeTools,
      customTools: customTools.length > 0 ? customTools : undefined,
      resourceLoader: options.resourceLoader,
      // HTTP requests are disposable and must never replace or persist the
      // interactive Pi session. Use a fresh in-memory manager per request.
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: options.settingsManager,
      sessionStartEvent: options.sessionStartEvent,
    });
    signal.addEventListener("abort", () => { void result.session.abort(); }, { once: true });
    return result.session;
  };
}

// Kept separate from CreateAgentSessionOptions because model selection is a MINAI concern.
export type PiSdkRequestSessionConfig = PiSdkRequestSessionOptions & { modelReference: ModelReference };
