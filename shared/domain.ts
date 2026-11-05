import { z } from "zod";

export const ProviderId = z.enum([
  "deepseek",
  "openai",
  "anthropic",
  "gemini",
  "qwen",
  "moonshot",
  "zhipu",
  "doubao",
  "compatible",
]);
export const Executor = z.enum(["codex", "claude-code"]);
export const Id = z.string().uuid();
export const Text = z.string().trim().min(1).max(16000);
export const ModelConfigSchema = z.object({
  provider: ProviderId,
  endpoint: z.string().url(),
  model: z.string().trim().min(1).max(200),
  thinking: z.boolean().default(false),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export const ProfileViewSchema = ModelConfigSchema.extend({
  hasKey: z.boolean(),
});
export const SettingsSchema = z.object({
  main: ProfileViewSchema.nullable(),
  attention: ProfileViewSchema.nullable(),
  attentionUseMain: z.boolean(),
  maxWorkers: z.number().int().min(1).max(4),
  codexModel: z.string(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const EmployeeSchema = z.object({
  id: Id,
  name: z.string(),
  role: z.string(),
  executor: Executor,
  attentionMode: z.enum(["auto", "mentions", "muted"]),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type Employee = z.infer<typeof EmployeeSchema>;
export const ConversationSchema = z.object({
  id: Id,
  title: z.string(),
  kind: z.enum(["direct", "group"]),
  memberIds: z.array(Id),
  createdAt: z.string(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
export const MessageSchema = z.object({
  id: Id,
  conversationId: Id,
  authorId: z.string(),
  content: z.string(),
  mentions: z.array(Id),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;
export const TaskStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("needs_approval"), reason: z.string() }),
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("running"), runId: Id }),
  z.object({ kind: z.literal("cancelling"), runId: Id }),
  z.object({ kind: z.literal("needs_input"), question: z.string() }),
  z.object({ kind: z.literal("review"), artifactId: Id }),
  z.object({ kind: z.literal("completed"), artifactId: Id }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("interrupted"), reason: z.string() }),
]);
export const TaskSchema = z.object({
  id: Id,
  title: z.string(),
  instruction: z.string(),
  employeeId: Id,
  conversationId: Id.nullable(),
  parentTaskId: Id.nullable(),
  criteria: z.array(z.string()),
  plan: z.array(z.string()),
  state: TaskStateSchema,
  version: z.number().int(),
  workspace: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  approval: z
    .object({
      version: z.number().int(),
      executor: Executor,
      model: z.string(),
      workspace: z.string(),
      scope: z.literal("workspace-write"),
      approvedAt: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export const ArtifactSchema = z.object({
  id: Id,
  taskId: Id,
  title: z.string(),
  content: z.string(),
  digest: z.string(),
  accepted: z.boolean(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
export const MemorySchema = z.object({
  id: Id,
  employeeId: Id,
  content: z.string(),
  createdAt: z.string(),
});
export type Memory = z.infer<typeof MemorySchema>;
export const NoticeSchema = z.object({
  id: Id,
  taskId: Id.nullable(),
  kind: z.enum(["decision", "result", "error", "observation"]),
  title: z.string(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type Notice = z.infer<typeof NoticeSchema>;
export const RuleSchema = z.object({
  id: Id,
  name: z.string(),
  instruction: z.string(),
  employeeId: Id,
  intervalMinutes: z.number().int().min(5),
  mode: z.enum(["observe", "propose"]),
  enabled: z.boolean(),
  nextRunAt: z.string(),
  createdAt: z.string(),
});
export type Rule = z.infer<typeof RuleSchema>;
export const ExecutorStatusSchema = z.object({
  executor: Executor,
  available: z.boolean(),
  detail: z.string(),
});
export const SnapshotSchema = z.object({
  employees: z.array(EmployeeSchema),
  conversations: z.array(ConversationSchema),
  messages: z.array(MessageSchema),
  tasks: z.array(TaskSchema),
  artifacts: z.array(ArtifactSchema),
  memories: z.array(MemorySchema),
  notices: z.array(NoticeSchema),
  rules: z.array(RuleSchema),
  settings: SettingsSchema,
  executors: z.array(ExecutorStatusSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const CreateEmployee = z.object({
  name: z.string().trim().min(1).max(40),
  role: Text,
  executor: Executor,
  attentionMode: z.enum(["auto", "mentions", "muted"]).default("auto"),
});
export const CreateConversation = z.object({
  title: z.string().trim().min(1).max(80),
  kind: z.enum(["direct", "group"]),
  memberIds: z.array(Id).min(1).max(12),
});
export const SendMessage = z.object({
  id: Id,
  content: Text,
  mentions: z.array(Id).max(12).default([]),
});
export const CreateTask = z.object({
  title: z.string().trim().min(1).max(120),
  instruction: Text,
  employeeId: Id,
  conversationId: Id.nullable().default(null),
  parentTaskId: Id.nullable().default(null),
  criteria: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
});
export const TaskAction = z.object({
  action: z.enum(["approve", "cancel", "accept", "rework", "resume"]),
  version: z.number().int().min(1),
  input: z.string().max(16000).optional(),
});
export const SaveModel = ModelConfigSchema.extend({
  purpose: z.enum(["main", "attention"]),
  apiKey: z.string().trim().max(4096).optional(),
});
export const SaveExecution = z.object({
  maxWorkers: z.number().int().min(1).max(4),
  codexModel: z.string().trim().max(200),
  attentionUseMain: z.boolean(),
});
export const CreateMemory = z.object({ employeeId: Id, content: Text });
export const CreateRule = z.object({
  name: z.string().trim().min(1).max(80),
  instruction: Text,
  employeeId: Id,
  intervalMinutes: z.number().int().min(5).max(10080),
  mode: z.enum(["observe", "propose"]).default("observe"),
});

export const PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    model: "deepseek-flash",
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1",
    model: "",
  },
  {
    id: "gemini",
    label: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "",
  },
  {
    id: "qwen",
    label: "通义千问",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "",
  },
  {
    id: "moonshot",
    label: "Moonshot · Kimi",
    endpoint: "https://api.moonshot.cn/v1",
    model: "",
  },
  {
    id: "zhipu",
    label: "智谱",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    model: "",
  },
  {
    id: "doubao",
    label: "豆包 · 火山引擎",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    model: "",
  },
  { id: "compatible", label: "OpenAI 兼容服务", endpoint: "", model: "" },
] satisfies {
  id: z.infer<typeof ProviderId>;
  label: string;
  endpoint: string;
  model: string;
}[];
