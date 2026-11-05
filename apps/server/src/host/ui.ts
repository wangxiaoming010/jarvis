import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Message } from '@openbot/shared';
import {
  validateDocument,
  resolve,
  visible,
  read,
  write,
  fieldError,
  withComputed,
  compileDocument,
} from '@openbot/shared/ui';
import type { ActionEnvelope, RenderDocument, Scope, State, Value } from '@openbot/shared/ui/types';
import type { Store } from '../store.js';

type Policy = { kind: 'reply' } | { kind: 'choose_bots'; options: Record<string, string[]> };
type Card = {
  message_id: string;
  group_id: string;
  bot_id: string | null;
  view_id: string;
  revision: number;
  document: string;
  policy: string;
  status: string;
  source_message_id: string | null;
};
const fail = (statusCode: number, text: string) => Object.assign(new Error(text), { statusCode });
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function scopes(doc: RenderDocument, state: State) {
  const found: { id: string; scope: Scope }[] = [];
  let count = 0;
  function visit(id: string, scope: Scope) {
    if (++count > 2048) throw fail(400, '卡片内容过多');
    const el = doc.spec.elements[id];
    if (!visible(el.visible, state, scope)) return;
    found.push({ id, scope });
    if (el.repeat) {
      const items = read(state, el.repeat.statePath) as Value[];
      items.forEach((item, index) => {
        const key = Buffer.from(JSON.stringify(read(item, '/' + el.repeat!.key))).toString(
          'base64',
        );
        el.children.forEach((child) =>
          visit(child, { item, index, instance: `${scope.instance}/item:${key}/${child}` }),
        );
      });
    } else
      el.children.forEach((child) =>
        visit(child, { ...scope, instance: `${scope.instance}/${child}` }),
      );
    for (const [slot, ids] of Object.entries(el.slots ?? {}))
      ids.forEach((child) =>
        visit(child, { ...scope, instance: `${scope.instance}/slot:${slot}/${child}` }),
      );
  }
  visit(doc.spec.root, { instance: doc.spec.root });
  return found;
}

export class UiService {
  constructor(
    private store: Store,
    private changed: () => void,
    private accepted: (message: Message) => void,
  ) {}
  publish(
    groupId: string,
    botId: string | null,
    raw: unknown,
    sourceId: string | null = null,
    policy: Policy = { kind: 'reply' },
  ) {
    const s = this.store.snapshot(),
      group = s.groups.find((g) => g.id === groupId);
    if (!group || (botId && !group.botIds.includes(botId))) throw fail(400, '卡片不属于当前群组');
    if (sourceId && !s.messages.some((m) => m.id === sourceId && m.groupId === groupId))
      throw fail(400, '引用的消息不在当前群组');
    let document: RenderDocument;
    try {
      document = validateDocument(raw);
    } catch {
      throw fail(400, '这张卡片格式不正确，请重新生成');
    }
    const previous = this.store.db
      .prepare(
        'SELECT bot_id,revision FROM ui_documents WHERE group_id=? AND view_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(groupId, document.context.viewId) as
      { bot_id: string | null; revision: number } | undefined;
    if (previous && (previous.bot_id !== botId || document.context.revision <= previous.revision))
      throw fail(409, '这张卡片已有更新，请刷新后重试');
    document.context = {
      threadId: groupId,
      viewId: previous ? document.context.viewId : randomUUID(),
      revision: previous ? document.context.revision : 1,
    };
    // The renderer can dispatch only host-defined actions, never an arbitrary URL or command.
    for (const el of Object.values(document.spec.elements))
      for (const binding of Object.values(el.on ?? {})) {
        if (binding.action === 'setState') continue;
        const actionId = binding.params.actionId;
        if (actionId !== (policy.kind === 'choose_bots' ? 'choose_bots' : 'reply'))
          throw fail(400, '卡片包含不支持的操作');
        if (policy.kind === 'reply')
          for (const [key, value] of Object.entries(binding.params)) {
            if (
              value &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              '$state' in value &&
              String(value.$state).startsWith('/form')
            ) {
              if (key !== 'input') throw fail(400, '表单输入必须通过 input 提交');
            }
          }
      }
    const root = document.spec.elements[document.spec.root];
    const initialView = withComputed(document.state, compileDocument(document));
    const heading = resolve(root.props.title ?? root.props.text, initialView);
    const title = typeof heading === 'string' ? heading : '请看一下这里';
    const message: Message = {
      id: randomUUID(),
      groupId,
      senderId: botId ?? 'system',
      senderType: botId ? 'bot' : 'system',
      content: title,
      mentions: [],
      replyTo: sourceId,
      timestamp: new Date().toISOString(),
      messageType: 'text',
      correlationId: s.messages.find((m) => m.id === sourceId)?.correlationId ?? null,
    };
    this.store.db.transaction(() => {
      if (previous)
        this.store.db
          .prepare(
            "UPDATE ui_documents SET status='superseded' WHERE group_id=? AND view_id=? AND status='pending'",
          )
          .run(groupId, document.context.viewId);
      this.store.insertMessage(message);
      this.store.db
        .prepare(
          'INSERT INTO ui_documents(message_id,group_id,bot_id,view_id,revision,document,policy,source_message_id) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          message.id,
          groupId,
          botId,
          document.context.viewId,
          document.context.revision,
          JSON.stringify(document),
          JSON.stringify(policy),
          sourceId,
        );
    })();
    this.changed();
    return { messageId: message.id, document };
  }
  action(messageId: string, envelope: ActionEnvelope) {
    const bodyHash = createHash('sha256').update(stable({ messageId, envelope })).digest('hex');
    const receipt = this.store.db
      .prepare('SELECT body_hash,response FROM ui_actions WHERE request_id=?')
      .get(envelope.requestId) as { body_hash: string; response: string } | undefined;
    if (receipt) {
      if (receipt.body_hash !== bodyHash) throw fail(409, '这次提交与之前不同，请刷新后重试');
      return JSON.parse(receipt.response);
    }
    const card = this.store.db
      .prepare('SELECT * FROM ui_documents WHERE message_id=?')
      .get(messageId) as Card | undefined;
    if (!card) throw fail(404, '卡片不存在');
    if (card.status !== 'pending') throw fail(409, '这张卡片已经处理过了');
    const doc = validateDocument(JSON.parse(card.document));
    if (!isDeepStrictEqual(envelope.context, doc.context))
      throw fail(409, '卡片已经更新，请刷新后重试');
    const el = doc.spec.elements[envelope.componentId],
      binding = el?.on?.[envelope.event];
    if (!binding || binding.action === 'setState' || binding.action !== envelope.action)
      throw fail(400, '这项操作不在卡片中');
    let state = doc.state;
    const inputBinding = binding.params.input;
    if (
      inputBinding &&
      typeof inputBinding === 'object' &&
      !Array.isArray(inputBinding) &&
      '$state' in inputBinding
    ) {
      const path = String(inputBinding.$state);
      if (path === '/form') {
        if (
          !envelope.params.input ||
          typeof envelope.params.input !== 'object' ||
          Array.isArray(envelope.params.input)
        )
          throw fail(400, '请填写表单');
        state = { ...state, form: structuredClone(envelope.params.input as Record<string, Value>) };
      } else if (path.startsWith('/form/'))
        state = write(state, path, envelope.params.input ?? null);
    }
    try {
      validateDocument({ ...doc, state });
    } catch {
      throw fail(400, '填写的内容格式不正确');
    }
    const view = withComputed(state, compileDocument({ ...doc, state }));
    const nodes = scopes(doc, view),
      node = nodes.find(
        (n) => n.id === envelope.componentId && n.scope.instance === envelope.instanceId,
      );
    if (!node) throw fail(400, '这项操作当前不可用');
    if (resolve(el.props.disabled, view, node.scope)) throw fail(400, '这项操作当前不可用');
    const expected = resolve(binding.params, view, node.scope) as Record<string, Value>;
    if (!isDeepStrictEqual(expected, envelope.params)) throw fail(400, '提交内容与卡片不一致');
    if (binding.action === 'submitForm')
      for (const n of nodes) {
        const error = fieldError(doc.spec.elements[n.id], view, n.scope);
        if (error) throw fail(400, error);
      }
    const policy = JSON.parse(card.policy) as Policy,
      s = this.store.snapshot(),
      group = s.groups.find((g) => g.id === card.group_id)!;
    let mentions: string[], content: string;
    if (policy.kind === 'choose_bots') {
      const ids = policy.options[String(expected.optionId)];
      if (!ids || ids.some((id) => !group.botIds.includes(id)))
        throw fail(409, '群组成员有变化，请重新选择');
      mentions = ids;
      content = `这件事交给 ${ids.map((id) => s.bots.find((b) => b.id === id)!.name).join('、')} 来做。`;
    } else {
      if (!card.bot_id || !group.botIds.includes(card.bot_id))
        throw fail(409, '这位伙伴已离开群组');
      mentions = [card.bot_id];
      const answers = nodes.flatMap((n) => {
        const props = resolve(doc.spec.elements[n.id].props, view, n.scope) as Record<
          string,
          Value
        >;
        const path = (doc.spec.elements[n.id].props.value as Record<string, Value> | undefined)
          ?.$bindState;
        const display = (value: Value): string => {
          const options = Array.isArray(props.options) ? props.options : [];
          const option = options.find(
            (o) => o && typeof o === 'object' && !Array.isArray(o) && o.value === value,
          ) as Record<string, Value> | undefined;
          return option
            ? String(option.label)
            : typeof value === 'boolean'
              ? value
                ? '是'
                : '否'
              : String(value ?? '');
        };
        return typeof path === 'string' && path.startsWith('/form/')
          ? [
              `${String(props.label ?? '选择')}：${Array.isArray(props.value) ? props.value.map(display).join('、') : display(props.value)}`,
            ]
          : [];
      });
      const label = resolve(el.props.label, view, node.scope);
      content =
        [typeof label === 'string' ? label : '', ...new Set(answers)].filter(Boolean).join('\n') ||
        '我选好了，按这个继续。';
    }
    const human: Message = {
      id: randomUUID(),
      groupId: card.group_id,
      senderId: s.user.id,
      senderType: 'human',
      content,
      mentions,
      replyTo: card.source_message_id ?? card.message_id,
      timestamp: new Date().toISOString(),
      messageType: 'text',
      correlationId: randomUUID(),
    };
    const response = { ok: true, messageId: human.id };
    this.store.db.transaction(() => {
      this.store.insertMessage(human);
      this.store.db
        .prepare(
          "UPDATE ui_documents SET status='submitted',response=?,document=? WHERE message_id=? AND status='pending'",
        )
        .run(content, JSON.stringify({ ...doc, state }), messageId);
      this.store.db
        .prepare('INSERT INTO ui_actions VALUES(?,?,?,?,?)')
        .run(
          envelope.requestId,
          messageId,
          bodyHash,
          JSON.stringify(response),
          new Date().toISOString(),
        );
      this.accepted(human);
    })();
    this.changed();
    return response;
  }
}

export function uiFromText(
  text: string,
): { document: RenderDocument; content: string } | undefined {
  const fenced = /```(?:opsique-ui(?:\/0\.1)?|openbot-ui)\s*\n([\s\S]*?)\n```/i.exec(text);
  const raw = fenced?.[1] ?? (text.trim().startsWith('{') ? text.trim() : null);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { protocolVersion?: string }).protocolVersion !== 'opsique-ui/0.1'
  )
    return;
  return {
    document: validateDocument(parsed),
    content: fenced ? text.replace(fenced[0], '').trim() : '',
  };
}
