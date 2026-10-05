import type { ModelReference } from "./contracts/common.js";
import type { SystemOneService } from "./contracts/system-one.js";
import { FileModelHostRegistry } from "./file-host-registry.js";
import type { ModelHostService, ModelRequirement } from "./model.js";
import type { LocalHostRuntime } from "./local-host-runtime.js";
import { ModelAutoSelector, type ModelAutoSelectorOptions, type ModelSelection, type ModelSelectionInput } from "./model-auto.js";

/** Routes model selection and execution to the host named by the filesystem registry. */
export class RegistryModelRouter {
  private readonly selector: ModelAutoSelector;
  constructor(private readonly registry: FileModelHostRegistry, systemOne?: SystemOneService, private readonly managedHosts?: LocalHostRuntime, selectorOptions: ModelAutoSelectorOptions = {}) { this.selector = new ModelAutoSelector(managedHosts?.catalog() ?? registry.catalogService(), systemOne, selectorOptions); }
  select(input: ModelSelectionInput, signal?: AbortSignal): Promise<ModelSelection> { return this.selector.select(input, signal); }
  host(reference: ModelReference): ModelHostService { return this.managedHosts?.host(reference) ?? this.registry.getModelHost(reference); }
  model(reference: ModelReference) { return this.managedHosts?.model(reference) ?? this.registry.getModel(reference); }
  candidates(requirements?: ModelRequirement): ModelReference[] { return this.registry.catalogService().filter(requirements).map(({ provider, id }) => ({ provider, id })); }
}
