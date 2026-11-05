import { useState } from 'react';
import { Button } from '@heroui/react';
import { ShieldCheck, MessageCircleQuestion } from 'lucide-react';
import type { NativeReply, NativeRequest } from '@openbot/shared';

export function NativeInteraction({
  request,
  connected,
  onReply,
}: {
  request: NativeRequest;
  connected: boolean;
  onReply: (id: string, response: NativeReply) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [submitted, setSubmitted] = useState<NativeReply | null>(null),
    [error, setError] = useState('');
  const pending = request.status === 'pending' && !submitted;
  const question = request.kind === 'question';
  const input = request.details?.input as Record<string, unknown> | undefined;
  const path = input?.file_path ?? input?.path;
  const permissions = request.details?.permissions as
    | { fileSystem?: { read?: string[]; write?: string[] }; network?: { enabled?: boolean } }
    | undefined;
  const response = request.response ?? submitted;
  const shown = pending ? answers : (response?.answers ?? answers);
  async function reply(response: NativeReply) {
    if (busy || !pending) return;
    setError('');
    if (!connected) {
      setError('连接已断开，恢复后可提交。');
      return;
    }
    setBusy(true);
    try {
      await onReply(request.id, response);
      setSubmitted(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : '暂时无法提交，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const values = Object.fromEntries(
      (request.questions ?? []).map((q) => {
        const selected = answers[q.id] ?? [],
          text = other[q.id]?.trim();
        return [q.id, text ? (q.multiSelect ? [...selected, text] : [text]) : selected];
      }),
    );
    if ((request.questions ?? []).some((q) => !values[q.id]?.length)) {
      setError('请回答所有问题。');
      return;
    }
    void reply({ decision: 'accept', answers: values });
  }
  return (
    <section
      className="native-interaction"
      data-native-request={request.id}
      aria-label={question ? '执行提问' : '操作授权'}
    >
      <div className="native-interaction-origin">
        {question ? <MessageCircleQuestion size={15} /> : <ShieldCheck size={15} />}
        <span>{question ? '需要回答' : '操作授权'}</span>
      </div>
      <strong className="native-interaction-title">{request.title}</strong>
      {request.reason && <p className="native-interaction-reason">{request.reason}</p>}
      {request.cwd && <p className="native-interaction-path">操作位置：{request.cwd}</p>}
      {typeof path === 'string' && <p className="native-interaction-path">文件：{path}</p>}
      {request.command && <pre className="native-interaction-command">{request.command}</pre>}
      {permissions?.fileSystem?.read?.map((p) => (
        <p className="native-interaction-path" key={'read' + p}>
          读取：{p}
        </p>
      ))}
      {permissions?.fileSystem?.write?.map((p) => (
        <p className="native-interaction-path" key={'write' + p}>
          写入：{p}
        </p>
      ))}
      {permissions?.network?.enabled && <p>请求允许网络访问</p>}
      {!!request.details && Object.keys(request.details).length > 0 && (
        <details className="native-interaction-details">
          <summary>查看操作详情</summary>
          <pre>{JSON.stringify(request.details, null, 2)}</pre>
        </details>
      )}
      {question && (
        <form onSubmit={submit}>
          <fieldset disabled={!pending || busy}>
            {request.questions?.map((q) => (
              <div className="native-question" key={q.id}>
                <label className="native-question-label" htmlFor={`native-${request.id}-${q.id}`}>
                  {q.question}
                </label>
                {q.options?.map((option) => (
                  <label className="native-question-option" key={option.label}>
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`${request.id}-${q.id}`}
                      checked={(shown[q.id] ?? []).includes(option.label)}
                      onChange={(e) => {
                        if (!q.multiSelect) setOther((o) => ({ ...o, [q.id]: '' }));
                        setAnswers((a) => ({
                          ...a,
                          [q.id]: q.multiSelect
                            ? e.target.checked
                              ? [...(a[q.id] ?? []), option.label]
                              : (a[q.id] ?? []).filter((v) => v !== option.label)
                            : [option.label],
                        }));
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                ))}
                {(!q.options?.length || q.allowOther) && (
                  <input
                    id={`native-${request.id}-${q.id}`}
                    type={q.isSecret ? 'password' : 'text'}
                    aria-label={q.options?.length ? `${q.question}（其他回答）` : q.question}
                    placeholder={q.options?.length ? '也可以填写其他回答' : '填写你的回答'}
                    value={
                      pending
                        ? (other[q.id] ?? '')
                        : (shown[q.id] ?? [])
                            .filter((v) => !q.options?.some((o) => o.label === v))
                            .join('、')
                    }
                    onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
                    autoComplete="off"
                  />
                )}
              </div>
            ))}
          </fieldset>
          {pending && (
            <div className="native-interaction-actions">
              <Button type="submit" className="accent-button" isPending={busy}>
                提交回答
              </Button>
              <Button
                variant="tertiary"
                isDisabled={busy}
                onPress={() => void reply({ decision: 'decline' })}
              >
                拒绝回答
              </Button>
            </div>
          )}
        </form>
      )}
      {!question && pending && (
        <div className="native-interaction-actions">
          <Button
            className="accent-button"
            isPending={busy}
            onPress={() => void reply({ decision: 'accept', scope: 'once' })}
          >
            允许本次
          </Button>
          {request.allowSession && (
            <Button
              variant="outline"
              isDisabled={busy}
              onPress={() => void reply({ decision: 'accept', scope: 'session' })}
            >
              本次会话允许
            </Button>
          )}
          <Button
            variant="tertiary"
            isDisabled={busy}
            onPress={() => void reply({ decision: 'decline' })}
          >
            拒绝
          </Button>
        </div>
      )}
      {error && (
        <p className="native-interaction-error" role="alert">
          {error}
        </p>
      )}
      {!pending && (
        <p className="native-interaction-status" role="status">
          {request.status === 'cancelled'
            ? '请求已失效'
            : response?.decision === 'decline'
              ? question
                ? '已拒绝回答'
                : '已拒绝'
              : question
                ? '已回答'
                : response?.scope === 'session'
                  ? '已允许本次会话'
                  : '已允许本次操作'}
        </p>
      )}
    </section>
  );
}
