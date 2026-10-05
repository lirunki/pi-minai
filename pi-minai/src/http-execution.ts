import { PiHttpStreamAdapter, PiHttpTextAdapter, type HttpPiSessionFactory } from "./http-protocol.js";
import { ExternalToolContinuationManager, type ContinuationSessionFactory } from "./http-continuation.js";
import type { HttpExecutionServices } from "./http-listener.js";
import type { RequestSessionFactory } from "./http-runtime.js";
import { randomUUID } from "node:crypto";

export type HttpExecutionFactoryOptions = { createSession: RequestSessionFactory; continuationTtlMs?: number };

/** Connects normalized HTTP adapters to request-owned Pi sessions. */
export function createPiHttpExecutionServices(options: HttpExecutionFactoryOptions): HttpExecutionServices {
  const createSession: HttpPiSessionFactory = ({ requestId, model, thinking, signal }) => options.createSession({ id: requestId ?? randomUUID(), model, thinking, signal: signal ?? new AbortController().signal });
  const text = new PiHttpTextAdapter(createSession);
  const stream = new PiHttpStreamAdapter(createSession);
  const continuationFactory: ContinuationSessionFactory = ({ model, thinking, tools, externalTools, signal }) => options.createSession({ id: randomUUID(), model, thinking, externalTools, externalToolDefinitions: tools, signal: signal ?? new AbortController().signal });
  const continuation = new ExternalToolContinuationManager(continuationFactory, options.continuationTtlMs);
  return { complete: (request, signal) => text.complete(request, signal), stream: (request, signal) => stream.stream(request, signal), continuation };
}
