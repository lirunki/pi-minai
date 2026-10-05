import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ServiceRegistry } from "../src/registry.js";
import { createSystemOneService, type JEVConfig } from "../src/jev.js";

export type JEVExtensionOptions = {
  registry: ServiceRegistry;
  config: JEVConfig;
};

export function registerJEVExtension(options: JEVExtensionOptions): void {
  options.registry.replace("candidate:system-one", createSystemOneService(options.config));
}

/**
 * Pi entrypoint. The shared service is intentionally not created at module import time.
 * A host application can call registerJEVExtension with its own registry/config.
 */
export default function jevExtension(_pi: ExtensionAPI): void {
  // Configuration and the application registry are supplied by the future MINAI bootstrap.
  // Keeping this entrypoint inert prevents a Pi session from silently making network calls.
}
