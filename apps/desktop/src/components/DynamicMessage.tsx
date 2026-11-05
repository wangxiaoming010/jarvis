import { useMemo } from 'react';
import type { Message } from '@openbot/shared';
import type { ActionEnvelope, State } from '@openbot/shared/ui/types';
import { validateDocument } from '@openbot/shared/ui';
import { Renderer } from '../renderer/Renderer';

export default function DynamicMessage({
  message,
  draftScope,
  connected,
  onAction,
}: {
  message: Message;
  draftScope: string;
  connected: boolean;
  onAction: (messageId: string, envelope: ActionEnvelope) => Promise<void>;
}) {
  const ui = message.ui!;
  const key = `openbot.ui.${draftScope}.${ui.document.context.viewId}.${ui.document.context.revision}`;
  const document = useMemo(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Pick<
        State,
        'form' | 'ui'
      > | null;
      if (draft && ui.status === 'pending')
        return validateDocument({
          ...ui.document,
          state: { ...ui.document.state, form: draft.form, ui: draft.ui },
        });
    } catch {
      sessionStorage.removeItem(key);
    }
    return ui.document;
  }, [key, ui.document, ui.status]);
  const title = ui.document.spec.elements[ui.document.spec.root].props.title;
  return (
    <div className="dynamic-message" data-view-id={ui.document.context.viewId}>
      {message.content && message.content !== title && (
        <p className="dynamic-intro">{message.content}</p>
      )}
      <Renderer
        key={`${key}.${ui.status}`}
        document={document}
        disabled={ui.status !== 'pending'}
        readOnlyNote={
          ui.status === 'superseded' ? '卡片已更新，此版本仅供查看。' : (ui.response ?? '已提交')
        }
        onStateChange={(state) =>
          sessionStorage.setItem(key, JSON.stringify({ form: state.form, ui: state.ui }))
        }
        onAction={async (envelope) => {
          if (!connected) throw new Error('连接已断开，填写内容已保留，恢复后可提交。');
          await onAction(message.id, envelope);
          sessionStorage.removeItem(key);
        }}
      />
    </div>
  );
}
