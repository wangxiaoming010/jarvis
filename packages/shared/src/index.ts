export type Provider = 'claude-code' | 'codex';
export type ModelProvider =
  'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'qwen' | 'moonshot' | 'zhipu' | 'compatible';
export interface ModelProviderOption {
  id: ModelProvider;
  name: string;
  baseUrl: string;
  model: string;
  attentionModel?: string;
  hasKey: boolean;
}
export interface ModelSettingsView {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  attentionModel?: string;
  hasKey: boolean;
  enabled: boolean;
  providers: ModelProviderOption[];
}
export interface AvailableModel {
  id: string;
  name: string;
}
export { conversationalText, workActivity, workProgress } from './presentation.js';
export type BotStatus = 'offline' | 'idle' | 'thinking' | 'working' | 'error';
export type TaskStatus =
  'queued' | 'running' | 'cancelling' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
export interface Group {
  id: string;
  name: string;
  description: string;
  botIds: string[];
  createdAt: string;
  directBotId?: string;
}
export type BotAvatarSpec = { type: 'emoji' | 'image'; value: string };
export interface Bot {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  provider: Provider;
  status: BotStatus;
  bridgeId: string | null;
  createdAt: string;
  avatar?: BotAvatarSpec | null;
}
export interface Message {
  id: string;
  groupId: string;
  senderId: string;
  senderType: 'human' | 'bot' | 'system';
  content: string;
  mentions: string[];
  replyTo: string | null;
  timestamp: string;
  messageType: 'text' | 'status';
  correlationId: string | null;
  nativeRequest?: NativeRequest;
  ui?: {
    document: import('./ui/types.js').RenderDocument;
    status: 'pending' | 'submitted' | 'superseded';
    response: string | null;
  };
}
export interface Task {
  id: string;
  goalId?: string | null;
  groupId: string;
  originGroupId?: string;
  botId: string;
  input: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: string | null;
  error: string | null;
  correlationId: string;
  round: number;
  execution?: TaskExecution;
}
export interface TaskExecution {
  contract?: {
    criteria: string[];
    nextAction: string;
    waitCondition: string | null;
    nextWakeAt: string | null;
    deadline: string | null;
    maxRuns: number;
    state: string;
  };
  workspace?: { root: string; path: string; baseCommit: string; review: string | null };
  pipeline?: { id: string; title: string };
  health?: {
    state: string;
    detail: string;
    lastActivityAt: string | null;
    lastHeartbeatAt: string | null;
    observedAt: string;
  };
  provider?: Provider;
  parentTaskId?: string | null;
  review?: string;
  version: number;
  executedVersion: number | null;
  goal: string;
  contextMessageId: string;
  activity: string | null;
  report: string | null;
  updatedAt: string;
  pendingChange: { instruction: string; status: 'pending' | 'interrupted' } | null;
  changes: { version: number; instruction: string; createdAt: string }[];
}
export interface Snapshot {
  goals?: WorkGoal[];
  artifacts?: WorkArtifact[];
  projects?: { id: string; name: string; groupIds: string[] }[];
  groups: Group[];
  bots: Bot[];
  messages: Message[];
  tasks: Task[];
  user: { id: string; name: string };
  revision: number;
  bridges?: BridgeInfo[];
  approvals?: Approval[];
  brain?: { enabled: boolean; healthy: boolean; error?: string };
  maxRounds?: number;
  dialogue?: { enabled: boolean };
  model?: { provider: ModelProvider; name: string; configured: boolean };
  conversations?: { botId: string; groupId: string; status: 'queued' | 'processing' }[];
  dialogueFailures?: {
    botId: string;
    groupId: string;
    messageId: string;
    error: string;
    stage?: 'attention' | 'dialogue';
  }[];
}
export interface WorkGoal {
  id: string;
  botId: string;
  groupId: string;
  sourceMessageId: string | null;
  projectId: string | null;
  title: string;
  criteria: string[];
  version: number;
  state: 'active' | 'waiting' | 'needs_attention' | 'completed' | 'cancelled';
  nextAction: string;
  nextCheckAt: string | null;
  deadline: string | null;
  generation: number;
  unattendedChecks: number;
  attentionReason: string | null;
  ownerWait: number;
  legacy: number;
  delivery: 'accepted' | 'applied';
  verification: 'reviewed' | 'content';
  result: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkArtifact {
  id: string;
  goalId: string;
  taskId: string | null;
  producerRunId: string | null;
  title: string;
  kind: 'file' | 'git' | 'report';
  locator: string;
  applicationPath: string | null;
  version: number;
  digest: string;
  manifest: string;
  state: 'produced' | 'verified' | 'accepted' | 'applied';
  createdAt: string;
  updatedAt: string;
}
export const providerLabel: Record<Provider, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};
export const statusLabel: Record<BotStatus, string> = {
  offline: '未连接',
  idle: '待命',
  thinking: '思考中',
  working: '执行中',
  error: '执行异常',
};
export function resolveMentions(content: string, bots: Pick<Bot, 'id' | 'name'>[]): string[] {
  const names = new Set(
    Array.from(content.matchAll(/@([\p{L}\p{N}_-]+)/gu), (match) => match[1].toLowerCase()),
  );
  return bots.filter((bot) => names.has(bot.name.toLowerCase())).map((bot) => bot.id);
}

export interface BridgeInfo {
  id: string;
  name: string;
  providers: {
    provider: Provider;
    version: string;
    available: boolean;
    reason?: string;
    autoMode?: boolean;
    autoModeReason?: string;
  }[];
}
export type ExecutionPermissionMode = 'auto' | 'manual';
export interface ExecutionSettingsView {
  mode: ExecutionPermissionMode;
  providers: {
    bridgeId: string;
    bridgeName: string;
    provider: Provider;
    autoMode: boolean;
    reason?: string;
  }[];
}
export interface Approval {
  id: string;
  taskId: string;
  kind: 'command' | 'file';
  detail: { command?: string; cwd?: string; reason?: string };
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  createdAt: string;
}
export interface AgentJob {
  permissionMode?: ExecutionPermissionMode;
  executionDirectory?: string;
  projectFacts?: { id: string; key: string; version: number; kind: string; content: string }[];
  artifactsToVerify?: WorkArtifact[];
  task: Task;
  leaseId: string;
  bot: Bot;
  group: Group;
  members: Pick<Bot, 'id' | 'name' | 'description'>[];
  messages: Message[];
  session: { threadId: string; lastMessageId: string | null } | null;
  sourceMessageId: string;
  acceptedVersion?: number;
  resourceMode?: 'read' | 'exclusive' | 'worktree';
}
export interface NativeQuestion {
  id: string;
  header: string;
  question: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
  allowOther?: boolean;
  isSecret?: boolean;
}
export interface NativeRequestSpec {
  kind: 'question' | 'permission' | 'command' | 'file' | 'tool';
  title: string;
  reason?: string;
  command?: string;
  cwd?: string;
  details?: Record<string, unknown>;
  questions?: NativeQuestion[];
  allowSession?: boolean;
}
export interface NativeReply {
  decision: 'accept' | 'decline';
  answers?: Record<string, string[]>;
  scope?: 'once' | 'session';
}
export interface NativeRequest extends NativeRequestSpec {
  id: string;
  taskId: string;
  status: 'pending' | 'answered' | 'cancelled';
  response: NativeReply | null;
}
export type BridgeCommand =
  | { type: 'run'; job: AgentJob }
  | { type: 'cancel'; taskId: string; leaseId: string }
  | {
      type: 'native_reply';
      taskId: string;
      leaseId: string;
      requestId: string;
      response: NativeReply;
    }
  | {
      type: 'approval';
      taskId: string;
      leaseId: string;
      requestId: string;
      decision: 'accept' | 'decline';
    }
  | { type: 'ping' }
  | { type: 'ready' };
