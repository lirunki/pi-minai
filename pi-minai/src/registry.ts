import { ServiceUnavailableError } from "./errors.js";
import type { ServiceName } from "./contracts/common.js";
import type { SystemOneService } from "./contracts/system-one.js";
import type { GuidanceCatalogService, GuidanceSelectorService } from "./guidance.js";
import type { ModelCatalogService, ModelHostService } from "./model.js";
import type { ModelSelectorService } from "./model-auto.js";

export type ServiceMap = {
  "candidate:system-one"?: SystemOneService;
  "catalog:guidance"?: GuidanceCatalogService;
  "selector:guidance"?: GuidanceSelectorService;
  "catalog:model"?: ModelCatalogService;
  "hoster:model"?: ModelHostService;
  "selector:model"?: ModelSelectorService;
  "context:artifacts"?: unknown;
  "runtime:orchestrator"?: unknown;
  "tools:python"?: unknown;
};

export class ServiceRegistry {
  private readonly services = new Map<ServiceName, unknown>();

  register<Name extends ServiceName>(name: Name, service: NonNullable<ServiceMap[Name]>): void {
    if (this.services.has(name)) throw new Error(`Service is already registered: ${name}`);
    this.services.set(name, service);
  }

  replace<Name extends ServiceName>(name: Name, service: NonNullable<ServiceMap[Name]>): void {
    this.services.set(name, service);
  }

  has(name: ServiceName): boolean {
    return this.services.has(name);
  }

  get<Name extends ServiceName>(name: Name): ServiceMap[Name] {
    return this.services.get(name) as ServiceMap[Name];
  }

  require<Name extends ServiceName>(name: Name): NonNullable<ServiceMap[Name]> {
    const service = this.get(name);
    if (service === undefined) throw new ServiceUnavailableError(name);
    return service as NonNullable<ServiceMap[Name]>;
  }

  clear(): void {
    this.services.clear();
  }
}
