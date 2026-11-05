import type { Employee, ModelConfig } from "../shared/domain.ts";

export type SecretProfile = ModelConfig & { apiKey: string };
export interface ModelInput {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}
export interface Proposal {
  title: string;
  instruction: string;
  criteria: string[];
  employeeId?: string;
}
export interface ModelReply {
  text: string;
  proposals: Proposal[];
}
export interface ModelGateway {
  respond(
    profile: SecretProfile,
    input: ModelInput,
    signal: AbortSignal,
    beforeStart?: () => void,
  ): Promise<ModelReply>;
  attention(
    profile: SecretProfile,
    input: ModelInput,
    signal: AbortSignal,
    beforeStart?: () => void,
  ): Promise<boolean>;
}
export interface ExecutionRequest {
  executor: Employee["executor"];
  workspace: string;
  instruction: string;
  model: string;
  signal: AbortSignal;
  beforeStart?: () => void;
}
export interface ExecutionGateway {
  status(): Promise<
    { executor: Employee["executor"]; available: boolean; detail: string }[]
  >;
  run(request: ExecutionRequest): Promise<{ text: string }>;
}
export interface Gateways {
  models: ModelGateway;
  executors: ExecutionGateway;
}
