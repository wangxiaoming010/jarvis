import { z } from "zod";
import {
  Id,
  CreateEmployee,
  CreateConversation,
  SendMessage,
  CreateTask,
  TaskAction,
  SaveExecution,
  CreateMemory,
  CreateRule,
  SnapshotSchema,
  EmployeeSchema,
  ConversationSchema,
  MessageSchema,
  TaskSchema,
  TaskStateSchema,
  ArtifactSchema,
  MemorySchema,
  NoticeSchema,
  RuleSchema,
  SettingsSchema,
  ProfileViewSchema,
  ExecutorStatusSchema,
} from "./domain.ts";

export const UpdateEmployee = CreateEmployee.partial()
  .extend({
    enabled: z.boolean().optional(),
    attentionMode: z.enum(["auto", "mentions", "muted"]).optional(),
  })
  .strict();
export const CommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("employee.create"),
      input: CreateEmployee.strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("employee.update"),
      id: Id,
      input: UpdateEmployee,
    })
    .strict(),
  z
    .object({
      kind: z.literal("conversation.create"),
      input: CreateConversation.strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message.send"),
      id: Id,
      input: SendMessage.strict(),
    })
    .strict(),
  z
    .object({ kind: z.literal("task.create"), input: CreateTask.strict() })
    .strict(),
  z
    .object({
      kind: z.literal("task.action"),
      id: Id,
      input: TaskAction.strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("execution.update"),
      input: SaveExecution.strict(),
    })
    .strict(),
  z
    .object({ kind: z.literal("memory.create"), input: CreateMemory.strict() })
    .strict(),
  z.object({ kind: z.literal("memory.delete"), id: Id }).strict(),
  z
    .object({ kind: z.literal("rule.create"), input: CreateRule.strict() })
    .strict(),
  z
    .object({ kind: z.literal("rule.update"), id: Id, enabled: z.boolean() })
    .strict(),
  z.object({ kind: z.literal("notice.read"), id: Id }).strict(),
]);
export type Command = z.infer<typeof CommandSchema>;
export const SubmitSchema = z
  .object({ requestId: Id, command: CommandSchema })
  .strict();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Instant = z.string().datetime();
const Generation = z.number().int().positive();
export const AddressedCommandSchema = z
  .object({
    commandId: Id,
    deviceId: Id,
    generation: Generation,
    digest: Digest,
    expiresAt: Instant,
    command: CommandSchema,
  })
  .strict();
export type AddressedCommand = z.infer<typeof AddressedCommandSchema>;
const receiptFields = { commandId: Id, updatedAt: Instant };
export const TerminalReceiptSchema = z.discriminatedUnion("status", [
  z.object({ ...receiptFields, status: z.literal("applied") }).strict(),
  z
    .object({
      ...receiptFields,
      status: z.literal("rejected"),
      code: z.string().regex(/^[A-Z0-9_]{1,80}$/),
    })
    .strict(),
  z
    .object({
      ...receiptFields,
      status: z.literal("unknown"),
      code: z.literal("CRASH_WINDOW"),
    })
    .strict(),
  z.object({ ...receiptFields, status: z.literal("expired") }).strict(),
]);
export type TerminalReceipt = z.infer<typeof TerminalReceiptSchema>;
export const ReceiptSchema = z.union([
  TerminalReceiptSchema,
  z
    .object({
      ...receiptFields,
      status: z.enum(["queued", "delivered"]),
      expiresAt: Instant,
    })
    .strict(),
]);
export type Receipt = z.infer<typeof ReceiptSchema>;

// 路径只作为展示别名上云，不能经回执反向变成 Mac 执行目录。
const StrictSnapshotSchema = SnapshotSchema.extend({
  employees: z.array(EmployeeSchema.strict()),
  conversations: z.array(ConversationSchema.strict()),
  messages: z.array(MessageSchema.strict()),
  tasks: z.array(
    TaskSchema.extend({
      state: z.discriminatedUnion("kind", [
        TaskStateSchema.options[0].strict(),
        ...TaskStateSchema.options.slice(1).map((option) => option.strict()),
      ]),
      approval: TaskSchema.shape.approval.unwrap().strict().nullable(),
    }).strict(),
  ),
  artifacts: z.array(ArtifactSchema.strict()),
  memories: z.array(MemorySchema.strict()),
  notices: z.array(NoticeSchema.strict()),
  rules: z.array(RuleSchema.strict()),
  settings: SettingsSchema.extend({
    main: ProfileViewSchema.strict().nullable(),
    attention: ProfileViewSchema.strict().nullable(),
  }).strict(),
  executors: z.array(ExecutorStatusSchema.strict()),
}).strict();
export const PublishedSnapshotSchema = StrictSnapshotSchema.superRefine(
  (snapshot, ctx) => {
    for (const [index, task] of snapshot.tasks.entries()) {
      const alias = `mac-task:${task.id}`;
      if (
        (task.workspace !== null && task.workspace !== alias) ||
        (task.approval !== null && task.approval.workspace !== alias)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index],
          message: "只允许任务目录别名",
        });
      }
    }
  },
);
export const PublicationSchema = z
  .object({
    revision: z.number().int().positive(),
    snapshot: PublishedSnapshotSchema,
  })
  .strict();
export type Publication = z.infer<typeof PublicationSchema>;
export const SyncInputSchema = z
  .object({
    deviceId: Id,
    generation: Generation,
    receipts: z.array(TerminalReceiptSchema).max(100),
    publication: PublicationSchema.optional(),
  })
  .strict();
export const SyncReplySchema = z
  .object({
    leaseMs: z.number().int().min(1000).max(30000),
    acknowledgedIds: z.array(Id).max(100),
    command: AddressedCommandSchema.nullable(),
  })
  .strict();
export const PairInputSchema = z
  .object({ code: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const DeviceCredentialSchema = z
  .object({
    deviceId: Id,
    generation: Generation,
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type DeviceCredential = z.infer<typeof DeviceCredentialSchema>;
export const CloudViewSchema = z
  .object({
    snapshot: PublishedSnapshotSchema.nullable(),
    link: z
      .object({
        state: z.enum(["unpaired", "online", "offline", "revoked"]),
        lastSyncedAt: Instant.nullable(),
        deviceId: Id.nullable(),
        generation: z.number().int().nonnegative(),
      })
      .strict(),
    receipts: z.array(ReceiptSchema).max(100),
  })
  .strict();
export type CloudView = z.infer<typeof CloudViewSchema>;
export const MAX_PUBLICATION_BYTES = 4 * 1024 * 1024;
export const LEASE_MS = 15000;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    Number(url.port) < 1024 ||
    Number(url.port) > 65535
  )
    throw new Error("首版只允许通过 SSH 转发的 http://127.0.0.1:端口 地址");
  return url.origin;
}
