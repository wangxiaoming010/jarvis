import type { NativeRequestSpec, NativeReply } from '@openbot/shared';
import { nativeRequestSchema, nativeReplySchema } from '@openbot/shared/schemas';

export function codexRequest(
  method: string,
  p: Record<string, any>,
): NativeRequestSpec | undefined {
  const common = {
    ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
    ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
  };
  if (method === 'item/tool/requestUserInput')
    return nativeRequestSchema.parse({
      kind: 'question',
      title: '需要你回答几个问题',
      questions: p.questions?.map((q: any) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        ...(q.options?.length ? { options: q.options } : {}),
        allowOther: Boolean(q.isOther) || !q.options?.length,
        isSecret: Boolean(q.isSecret),
      })),
    });
  if (method === 'item/permissions/requestApproval')
    return nativeRequestSchema.parse({
      kind: 'permission',
      title: '需要你确认访问权限',
      ...common,
      details: { permissions: p.permissions },
      allowSession: true,
    });
  if (method === 'item/commandExecution/requestApproval')
    return nativeRequestSchema.parse({
      kind: 'command',
      title: p.networkApprovalContext ? '需要你允许网络访问' : '需要你允许运行命令',
      ...common,
      ...(typeof p.command === 'string' ? { command: p.command } : {}),
      details: {
        ...(p.networkApprovalContext ? { network: p.networkApprovalContext } : {}),
        ...(p.additionalPermissions ? { additionalPermissions: p.additionalPermissions } : {}),
      },
    });
  if (method === 'item/fileChange/requestApproval')
    return nativeRequestSchema.parse({
      kind: 'file',
      title: '需要你允许修改文件',
      ...common,
      details: {
        ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}),
        ...(p.changes ? { changes: p.changes } : {}),
      },
    });
}
export function claudeRequest(
  tool: string,
  input: Record<string, any>,
  reason?: string,
): NativeRequestSpec {
  if (tool === 'AskUserQuestion')
    return nativeRequestSchema.parse({
      kind: 'question',
      title: '需要你回答几个问题',
      questions: input.questions?.map((q: any, index: number) => ({
        id: `question-${index}`,
        header: q.header ?? '',
        question: q.question,
        options: q.options?.map((o: any) => ({ label: o.label, description: o.description ?? '' })),
        multiSelect: Boolean(q.multiSelect),
        allowOther: true,
      })),
    });
  return nativeRequestSchema.parse({
    kind:
      tool === 'Bash'
        ? 'command'
        : ['Edit', 'Write', 'NotebookEdit'].includes(tool)
          ? 'file'
          : 'tool',
    title:
      tool === 'WebFetch'
        ? '需要你允许读取网页'
        : tool === 'Bash'
          ? '需要你允许运行命令'
          : ['Edit', 'Write', 'NotebookEdit'].includes(tool)
            ? '需要你允许修改文件'
            : `需要你允许使用 ${tool}`,
    ...(reason ? { reason } : {}),
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    details: { tool, input },
  });
}
export function checkedReply(spec: NativeRequestSpec, raw: NativeReply) {
  const reply = nativeReplySchema.parse(raw);
  if (reply.scope === 'session' && (!spec.allowSession || spec.kind === 'question'))
    throw new Error('不支持持续授权');
  if (spec.kind === 'question' && reply.decision === 'accept') {
    if (Object.keys(reply.answers ?? {}).some((id) => !spec.questions?.some((q) => q.id === id)))
      throw new Error('问题已变化');
    for (const q of spec.questions ?? []) {
      const a = reply.answers?.[q.id];
      if (
        !a?.length ||
        (!q.multiSelect && a.length !== 1) ||
        new Set(a).size !== a.length ||
        a.some((v) => q.options?.length && !q.allowOther && !q.options.some((o) => o.label === v))
      )
        throw new Error('回答不属于当前问题');
    }
  } else if (Object.keys(reply.answers ?? {}).length) throw new Error('这条请求不接受附加回答');
  return reply;
}
export function codexReply(
  method: string,
  params: Record<string, any>,
  spec: NativeRequestSpec,
  raw: NativeReply,
) {
  const reply = checkedReply(spec, raw),
    accepted = reply.decision === 'accept';
  if (method === 'item/tool/requestUserInput')
    return {
      answers: accepted
        ? Object.fromEntries(
            (spec.questions ?? []).map((q) => [q.id, { answers: reply.answers![q.id] }]),
          )
        : {},
    };
  if (method === 'item/permissions/requestApproval')
    return {
      permissions: accepted ? params.permissions : {},
      scope: reply.scope === 'session' ? 'session' : 'turn',
    };
  return { decision: accepted ? 'accept' : 'decline' };
}
