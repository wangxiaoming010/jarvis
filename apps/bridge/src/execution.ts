import type { Approval, NativeRequestSpec, NativeReply } from '@openbot/shared';

export interface AgentResult {
  status: 'completed' | 'failed' | 'cancelled';
  text: string;
  error?: string;
}
export interface AgentCallbacks {
  session: (id: string) => void;
  progress: (text: string) => void;
  approval: (id: string, kind: 'command' | 'file', detail: Approval['detail']) => void;
  activity?: (text: string, report?: string) => void;
  report?: (kind: 'progress' | 'milestone' | 'blocked', summary: string) => void;
  started?: () => void;
  interaction?: (id: string, request: NativeRequestSpec) => void;
  interactionResolved?: (id: string) => void;
}
export interface AgentExecution {
  run(): Promise<AgentResult>;
  cancel(): Promise<void>;
  approve?(requestId: string, decision: 'accept' | 'decline'): void;
  respond?(requestId: string, response: NativeReply): boolean;
}
