import type { SystemOneRequest, SystemOneResponse, SystemOneService } from "./contracts/system-one.js";
import { validateSystemOneRequest, validateSystemOneResponse } from "./contracts/validate.js";
import { SystemOneError } from "./errors.js";
import { LocalSystemOneService, type LocalSystemOneTier } from "./local-jev.js";

export type JEVRemoteConfig = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
};

export type JEVConfig = {
  backend: "remote" | "local" | "fake" | "auto";
  remote: JEVRemoteConfig;
  escalate_to_llm?: boolean;
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function endpointFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/v1/systemone`;
}

export class RemoteSystemOneService implements SystemOneService {
  private readonly fetchImpl: FetchLike;
  private readonly config: JEVRemoteConfig;

  constructor(config: JEVRemoteConfig, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
    validateSystemOneRequest(request);
    const timeoutMs = this.config.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("System One request timed out")), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
      let response: Response;
      try {
        response = await this.fetchImpl(endpointFor(this.config.baseUrl), {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SystemOneError("System One request timed out or was aborted", "jev_timeout", { cause: error });
        }
        throw new SystemOneError("System One transport failed", "jev_transport", { cause: error });
      }

      const raw = await response.text();
      if (!response.ok) {
        throw new SystemOneError(`System One returned HTTP ${response.status}`, "jev_http", {
          cause: new Error(raw.slice(0, 500)),
        });
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (error) {
        throw new SystemOneError("System One returned invalid JSON", "jev_transport", { cause: error });
      }
      validateSystemOneResponse(decoded, request);
      return decoded;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export type FakeSystemOneHandler = (request: SystemOneRequest, signal?: AbortSignal) => SystemOneResponse | Promise<SystemOneResponse>;

export class FakeSystemOneService implements SystemOneService {
  public readonly requests: SystemOneRequest[] = [];

  constructor(private readonly handler: FakeSystemOneHandler) {}

  async systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
    validateSystemOneRequest(request);
    this.requests.push(structuredClone(request));
    const response = await this.handler(request, signal);
    validateSystemOneResponse(response, request);
    return response;
  }
}

export function createSystemOneService(config: JEVConfig, options?: { fetch?: FetchLike; fake?: SystemOneService; localTiers?: LocalSystemOneTier[] }): SystemOneService {
  if (config.backend === "remote") return new RemoteSystemOneService(config.remote, options?.fetch);
  if (config.backend === "local" || config.backend === "auto") return new LocalSystemOneService(options?.localTiers);
  if (options?.fake) return options.fake;
  throw new SystemOneError("The fake JEV backend requires an injected fake service", "jev_backend");
}
