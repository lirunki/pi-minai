export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
};

export type ModelReference = {
  provider: string;
  id: string;
};

export type AvailableModel = ModelReference & {
  contextWindow: number;
  maxOutputTokens: number;
  description?: string;
  capabilities: ModelCapabilities;
  locality: "local" | "remote";
  availability: "ready" | "cold" | "offline";
  quality?: number;
  cost?: {
    input: number;
    output: number;
  };
};

export type GuidanceDefinition = {
  id: string;
  description: string;
  purpose?: string;
  tags?: string[];
};

export type ArtifactReference = {
  id: string;
  kind: string;
  producerTaskId?: string;
};

export type RuntimeEvent = {
  type: string;
  requestId: string;
  taskId?: string;
  timestamp: string;
  data?: Record<string, unknown>;
};

export type ServiceName =
  | "candidate:system-one"
  | "catalog:guidance"
  | "selector:guidance"
  | "catalog:model"
  | "hoster:model"
  | "selector:model"
  | "context:artifacts"
  | "runtime:orchestrator"
  | "tools:python";
