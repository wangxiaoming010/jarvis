import React, { FormEvent, useCallback, useEffect, useState } from "react";
import {
  PROVIDERS,
  SnapshotSchema,
  type Snapshot,
  type Task,
  type Employee,
  type ModelConfig,
} from "../shared/domain";

type Page = "总览" | "任务" | "数字员工" | "会话" | "交付物" | "设置";
type Modal =
  "task" | "employee" | "conversation" | "rule" | "approval" | "rework" | null;
const pages: { name: Page; icon: string; hint: string }[] = [
  { name: "总览", icon: "◫", hint: "工作概况" },
  { name: "任务", icon: "▤", hint: "计划与执行" },
  { name: "数字员工", icon: "◇", hint: "协作成员" },
  { name: "会话", icon: "▢", hint: "讨论与委托" },
  { name: "交付物", icon: "▧", hint: "结果与验收" },
  { name: "设置", icon: "⚙", hint: "模型与执行" },
];
const stateNames: Record<Task["state"]["kind"], string> = {
  needs_approval: "待批准",
  queued: "排队中",
  running: "执行中",
  cancelling: "取消中",
  needs_input: "需要你",
  review: "待验收",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const attentionNames = {
  auto: "自动参与",
  mentions: "仅 @ 时参与",
  muted: "静默",
};
const date = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
async function request(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers:
      method === "GET"
        ? {}
        : { "Content-Type": "application/json", "X-Jarvis-Request": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      `${typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : "请求失败"} (${response.status})`,
    );
  return data;
}
function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
function Empty({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">◇</div>
      <strong>{title}</strong>
      <p>{desc}</p>
    </div>
  );
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [login, setLogin] = useState(false),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [page, setPage] = useState<Page>("总览"),
    [modal, setModal] = useState<Modal>(null),
    [selectedTask, setSelectedTask] = useState<Task | null>(null),
    [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null),
    [conversationId, setConversationId] = useState("");
  const [taskTitle, setTaskTitle] = useState(""),
    [instruction, setInstruction] = useState(""),
    [criteria, setCriteria] = useState(""),
    [employeeId, setEmployeeId] = useState("");
  const [name, setName] = useState(""),
    [role, setRole] = useState(""),
    [executor, setExecutor] = useState<"codex" | "claude-code">("codex"),
    [attentionMode, setAttentionMode] = useState<"auto" | "mentions" | "muted">(
      "auto",
    );
  const [conversationTitle, setConversationTitle] = useState(""),
    [kind, setKind] = useState<"direct" | "group">("direct"),
    [members, setMembers] = useState<string[]>([]),
    [message, setMessage] = useState(""),
    [mentions, setMentions] = useState<string[]>([]),
    [memory, setMemory] = useState("");
  const [ruleName, setRuleName] = useState(""),
    [ruleInstruction, setRuleInstruction] = useState(""),
    [interval, setIntervalValue] = useState(60),
    [ruleMode, setRuleMode] = useState<"observe" | "propose">("observe"),
    [input, setInput] = useState("");
  const refresh = useCallback(async () => {
    try {
      const s = SnapshotSchema.parse(await request("/api/snapshot"));
      setSnapshot(s);
      setLogin(false);
    } catch (e) {
      if (e instanceof Error && /401|认证|会话|登录|unauth/i.test(e.message))
        setLogin(true);
      else setError(e instanceof Error ? e.message : "读取失败");
    }
  }, []);
  const signIn = useCallback(
    async (t: string) => {
      try {
        await request("/api/session", "POST", { token: t });
        setToken("");
        setLogin(false);
        await refresh();
      } catch (e) {
        setLogin(true);
        setError(e instanceof Error ? e.message : "登录失败");
      }
    },
    [refresh],
  );
  useEffect(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const t = hash.get("token");
    if (location.hash)
      history.replaceState(null, "", location.pathname + location.search);
    if (t) void signIn(t);
    else void refresh();
  }, [refresh, signIn]);
  useEffect(() => {
    if (login) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh, login]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(
      () =>
        document
          .querySelector<HTMLElement>(
            ".dialog input, .dialog select, .dialog textarea, .dialog button",
          )
          ?.focus(),
      0,
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModal(null);
        setSelectedTask(null);
        setSelectedEmployee(null);
        setInput("");
      }
      if (event.key === "Tab") {
        const elements = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".dialog button:not(:disabled), .dialog input:not(:disabled), .dialog select:not(:disabled), .dialog textarea:not(:disabled)",
          ),
        );
        if (!elements.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [modal]);
  const act = async (
    path: string,
    method: string,
    body: unknown,
    after?: () => void,
  ) => {
    setBusy(true);
    setError("");
    try {
      await request(path, method, body);
      after?.();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setModal(null);
    setSelectedTask(null);
    setSelectedEmployee(null);
    setInput("");
  };
  const newTask = () => {
    setTaskTitle("");
    setInstruction("");
    setCriteria("");
    setEmployeeId(snapshot?.employees.find((e) => e.enabled)?.id || "");
    setModal("task");
  };
  const editEmployee = (e?: Employee) => {
    setSelectedEmployee(e || null);
    setName(e?.name || "");
    setRole(e?.role || "");
    setExecutor(e?.executor || "codex");
    setAttentionMode(e?.attentionMode || "auto");
    setModal("employee");
  };
  const action = (task: Task, action: string, value?: string) =>
    void act(
      `/api/tasks/${task.id}/action`,
      "POST",
      { action, version: task.version, ...(value ? { input: value } : {}) },
      close,
    );
  const submit = (fn: () => void) => (e: FormEvent) => {
    e.preventDefault();
    fn();
  };
  if (login)
    return (
      <main className="login">
        <div className="login-card">
          <div className="brand-mark">J</div>
          <h1>欢迎使用 Jarvis</h1>
          <p>
            这是仅在本机运行的工作台。请从本机启动器打开，或粘贴本机访问令牌。
          </p>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={submit(() => void signIn(token))}>
            <Field label="本机令牌">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                autoComplete="off"
              />
            </Field>
            <button className="primary full">进入工作台</button>
          </form>
        </div>
      </main>
    );
  if (!snapshot)
    return (
      <main className="login">
        <div className="login-card">
          <div className="brand-mark">J</div>
          <h1>正在连接工作台</h1>
          {error && (
            <div className="alert" role="alert">
              {error}
              <button onClick={() => void refresh()}>重试</button>
            </div>
          )}
        </div>
      </main>
    );
  const s = snapshot,
    employee = (id: string) => s.employees.find((e) => e.id === id),
    selectedConversation = s.conversations.find((c) => c.id === conversationId),
    unread = s.notices.filter((n) => !n.read),
    pending = s.tasks.filter((t) =>
      [
        "needs_approval",
        "needs_input",
        "review",
        "failed",
        "interrupted",
      ].includes(t.state.kind),
    ),
    active = s.tasks.filter((t) =>
      ["queued", "running", "cancelling"].includes(t.state.kind),
    );
  const taskCard = (t: Task) => (
    <article className="task-card" key={t.id}>
      <div className="card-top">
        <Badge
          tone={
            ["failed", "interrupted"].includes(t.state.kind)
              ? "red"
              : ["needs_approval", "needs_input", "review"].includes(
                    t.state.kind,
                  )
                ? "amber"
                : "blue"
          }
        >
          {stateNames[t.state.kind]}
        </Badge>
        <span className="muted">{date(t.updatedAt)}</span>
      </div>
      <h3>{t.title}</h3>
      <p className="clamp">{t.instruction}</p>
      <div className="meta">
        <span>◇ {employee(t.employeeId)?.name || "未知员工"}</span>
        <span>版本 {t.version}</span>
      </div>
      {t.state.kind === "failed" && (
        <p className="error-text">{t.state.error}</p>
      )}
      {t.state.kind === "interrupted" && (
        <p className="error-text">{t.state.reason}</p>
      )}
      {t.state.kind === "needs_input" && <p>{t.state.question}</p>}
      {t.plan.length > 0 && (
        <details>
          <summary>查看计划</summary>
          <ol>
            {t.plan.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ol>
        </details>
      )}
      <div className="actions">
        {t.state.kind === "needs_approval" && (
          <button
            className="primary"
            onClick={() => {
              setSelectedTask(t);
              setModal("approval");
            }}
          >
            查看并批准
          </button>
        )}
        {["needs_approval", "queued", "running", "needs_input"].includes(
          t.state.kind,
        ) && <button onClick={() => action(t, "cancel")}>取消任务</button>}
        {t.state.kind === "review" && (
          <>
            <button className="primary" onClick={() => action(t, "accept")}>
              确认验收
            </button>
            <button
              onClick={() => {
                setSelectedTask(t);
                setModal("rework");
              }}
            >
              要求重做
            </button>
          </>
        )}
        {["failed", "interrupted", "cancelled", "needs_input"].includes(
          t.state.kind,
        ) && (
          <button
            onClick={() => {
              setSelectedTask(t);
              setModal("rework");
            }}
          >
            {t.state.kind === "needs_input" ? "回复并继续" : "重新提交审批"}
          </button>
        )}
      </div>
    </article>
  );
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">J</div>
          <div>
            <strong>Jarvis</strong>
            <small>个人智能工作台</small>
          </div>
        </div>
        <div className="side-label">工作空间</div>
        <nav aria-label="主导航">
          {pages.map((p) => (
            <button
              key={p.name}
              className={`nav-item ${page === p.name ? "active" : ""}`}
              onClick={() => setPage(p.name)}
            >
              <span className="nav-icon">{p.icon}</span>
              <span>{p.name}</span>
              {p.name === "总览" && unread.length > 0 && (
                <em>{unread.length}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <span className="status-dot" /> 本机工作空间{" "}
          <small>LOCAL WORKSPACE</small>
          <a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">
            第三方许可
          </a>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <span className="crumb">工作空间</span>
            <span className="sep">/</span>
            <strong>{page}</strong>
          </div>
          <div className="top-right">
            <span className="live">
              <i /> 定时同步
            </span>
            <button
              onClick={() => {
                setPage("总览");
              }}
              aria-label={`通知，${unread.length} 条未读`}
            >
              ♧ {unread.length > 0 && <b>{unread.length}</b>}
            </button>
            <span className="avatar">我</span>
          </div>
        </header>
        <main className="content">
          {error && (
            <div className="alert" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="关闭错误">
                ×
              </button>
            </div>
          )}
          {page === "总览" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR WORKSPACE</div>
                  <h1>工作台</h1>
                  <p>把想法交给团队，重要进展在这里汇合。</p>
                </div>
                <button className="primary" onClick={newTask}>
                  ＋ 新建任务
                </button>
              </div>
              {!s.settings.main?.hasKey && (
                <div className="privacy-note">
                  <strong>先连接你的对话模型</strong>
                  <p>
                    尚未配置主会话模型。员工对话需要 API Key；本机 Codex
                    执行使用它自己的登录。
                  </p>
                  <button onClick={() => setPage("设置")}>前往设置</button>
                </div>
              )}
              <div className="welcome">
                <div>
                  <span className="welcome-kicker">专注于真正重要的事</span>
                  <h2>今天，从一个清晰的目标开始。</h2>
                  <p>
                    明确交付目标，审批执行范围。任务在后台推进，你随时掌握进展。
                  </p>
                  <button onClick={newTask}>
                    {s.tasks.length ? "创建新任务" : "创建第一个任务"}{" "}
                    <span>↗</span>
                  </button>
                </div>
                <div className="welcome-art" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <div>✦</div>
                </div>
              </div>
              <div className="stats">
                <div>
                  <span>需要你关注</span>
                  <strong>{pending.length}</strong>
                  <small>审批、异常与验收</small>
                </div>
                <div>
                  <span>进行中</span>
                  <strong>{active.length}</strong>
                  <small>排队或正在执行</small>
                </div>
                <div>
                  <span>交付物</span>
                  <strong>{s.artifacts.length}</strong>
                  <small>可查看的任务结果</small>
                </div>
              </div>
              <div className="section-head">
                <div>
                  <h2>需要你</h2>
                  <p>有决定需要你做时，会显示在这里。</p>
                </div>
                <button className="link" onClick={() => setPage("任务")}>
                  查看全部任务 →
                </button>
              </div>
              {pending.length ? (
                <div className="card-grid">{pending.map(taskCard)}</div>
              ) : (
                <Empty
                  title="暂时没有待处理事项"
                  desc="新的审批、问题和验收会出现在这里。"
                />
              )}
              <div className="section-head">
                <div>
                  <h2>最新通知</h2>
                  <p>只在有结果、问题或失败时打扰你。</p>
                </div>
              </div>
              {s.notices.length ? (
                <div className="list-card">
                  {s.notices.slice(0, 8).map((n) => (
                    <div className="list-row" key={n.id}>
                      <span className={`notice-dot ${n.read ? "read" : ""}`} />
                      <div className="grow">
                        <strong>{n.title}</strong>
                        <small>
                          {date(n.createdAt)} ·{" "}
                          {n.kind === "observation"
                            ? "观察记录"
                            : n.kind === "error"
                              ? "异常"
                              : n.kind === "result"
                                ? "结果"
                                : "需要决定"}
                        </small>
                      </div>
                      {!n.read && (
                        <button
                          onClick={() =>
                            void act(`/api/notices/${n.id}/read`, "POST", {})
                          }
                        >
                          标为已读
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title="还没有通知"
                  desc="任务进展和规则观察会在需要时通知你。"
                />
              )}
            </>
          )}
          {page === "任务" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">TASKS</div>
                  <h1>任务</h1>
                  <p>从计划到交付，每一步都清晰可见。</p>
                </div>
                <button className="primary" onClick={newTask}>
                  ＋ 新建任务
                </button>
              </div>
              <div className="section-head">
                <div>
                  <h2>
                    全部任务 <span className="count">{s.tasks.length}</span>
                  </h2>
                  <p>批准后才会在专用工作目录内执行。</p>
                </div>
              </div>
              {s.tasks.length ? (
                <div className="card-grid">{s.tasks.map(taskCard)}</div>
              ) : (
                <Empty
                  title="还没有任务"
                  desc="创建任务并指定员工，确认执行范围后开始。"
                />
              )}
            </>
          )}
          {page === "数字员工" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">TEAM</div>
                  <h1>数字员工</h1>
                  <p>为不同工作配置合适的角色、工具和注意力。</p>
                </div>
                <button className="primary" onClick={() => editEmployee()}>
                  ＋ 添加员工
                </button>
              </div>
              {s.employees.length ? (
                <div className="employee-grid">
                  {s.employees.map((e) => (
                    <article className="employee-card" key={e.id}>
                      <div className="card-top">
                        <div className="employee-avatar">
                          {e.name.slice(0, 1)}
                        </div>
                        <Badge tone={e.enabled ? "green" : "neutral"}>
                          {e.enabled ? "已启用" : "已停用"}
                        </Badge>
                      </div>
                      <h3>{e.name}</h3>
                      <p>{e.role}</p>
                      <div className="employee-meta">
                        <span>执行工具</span>
                        <strong>
                          {e.executor === "codex" ? "Codex" : "Claude Code"}
                        </strong>
                        <span>注意力</span>
                        <strong>{attentionNames[e.attentionMode]}</strong>
                      </div>
                      <div className="actions">
                        <button onClick={() => editEmployee(e)}>
                          编辑资料
                        </button>
                        <button
                          onClick={() => {
                            setSelectedEmployee(e);
                            setMemory("");
                          }}
                        >
                          管理记忆
                        </button>
                        <button
                          onClick={() =>
                            void act(`/api/employees/${e.id}`, "PATCH", {
                              enabled: !e.enabled,
                            })
                          }
                        >
                          {e.enabled ? "停用" : "启用"}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  title="组建你的数字团队"
                  desc="添加员工并设置职责，开始协作。"
                />
              )}
              {selectedEmployee && !modal && (
                <section className="panel memory-panel">
                  <div className="section-head">
                    <div>
                      <h2>{selectedEmployee.name}的长期记忆</h2>
                      <p>仅保存明确添加的内容。</p>
                    </div>
                    <button onClick={() => setSelectedEmployee(null)}>
                      关闭
                    </button>
                  </div>
                  {s.memories
                    .filter((m) => m.employeeId === selectedEmployee.id)
                    .map((m) => (
                      <div className="list-row" key={m.id}>
                        <span className="grow">{m.content}</span>
                        <button
                          onClick={() =>
                            void act(`/api/memories/${m.id}`, "DELETE", {})
                          }
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  <form
                    className="inline-form"
                    onSubmit={submit(
                      () =>
                        void act(
                          "/api/memories",
                          "POST",
                          { employeeId: selectedEmployee.id, content: memory },
                          () => setMemory(""),
                        ),
                    )}
                  >
                    <input
                      value={memory}
                      onChange={(e) => setMemory(e.target.value)}
                      placeholder="添加一条长期记忆"
                      required
                    />
                    <button className="primary">添加</button>
                  </form>
                </section>
              )}
              <div className="section-head">
                <div>
                  <h2>关注规则</h2>
                  <p>
                    观察仅记录到期事件，不会检查外部系统。提出的任务仍需你批准。
                  </p>
                </div>
                <button
                  onClick={() => {
                    setEmployeeId(s.employees.find((e) => e.enabled)?.id || "");
                    setModal("rule");
                  }}
                >
                  ＋ 添加规则
                </button>
              </div>
              {s.rules.length ? (
                <div className="list-card">
                  {s.rules.map((r) => (
                    <div className="list-row" key={r.id}>
                      <div className="grow">
                        <strong>{r.name}</strong>
                        <small>
                          {r.mode === "observe" ? "观察模式" : "提出任务"} · 每{" "}
                          {r.intervalMinutes} 分钟 ·{" "}
                          {employee(r.employeeId)?.name}
                        </small>
                        <p>{r.instruction}</p>
                      </div>
                      <button
                        onClick={() =>
                          void act(`/api/rules/${r.id}`, "PATCH", {
                            enabled: !r.enabled,
                          })
                        }
                      >
                        {r.enabled ? "暂停" : "启用"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title="还没有关注规则"
                  desc="设置观察主题，按需生成待审批任务。"
                />
              )}
            </>
          )}
          {page === "会话" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">CONVERSATIONS</div>
                  <h1>会话</h1>
                  <p>与员工讨论问题，明确 @ 需要参与的成员。</p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setConversationTitle("");
                    setKind("direct");
                    setMembers([]);
                    setModal("conversation");
                  }}
                >
                  ＋ 新建会话
                </button>
              </div>
              <div className="chat-layout">
                <div className="chat-list">
                  {s.conversations.length ? (
                    s.conversations.map((c) => (
                      <button
                        key={c.id}
                        className={`chat-item ${conversationId === c.id ? "chosen" : ""}`}
                        onClick={() => {
                          setConversationId(c.id);
                          setMentions([]);
                        }}
                      >
                        <span className="chat-icon">
                          {c.kind === "group" ? "◈" : "◇"}
                        </span>
                        <span>
                          <strong>{c.title}</strong>
                          <small>
                            {c.kind === "group" ? "群聊" : "私聊"} ·{" "}
                            {c.memberIds.length} 位成员
                          </small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <Empty title="暂无会话" desc="创建私聊或群聊，开始讨论。" />
                  )}
                </div>
                <div className="chat-main">
                  {selectedConversation ? (
                    <>
                      <div className="chat-header">
                        <strong>{selectedConversation.title}</strong>
                        <small>
                          {selectedConversation.memberIds
                            .map((id) => employee(id)?.name || "未知员工")
                            .join("、")}
                        </small>
                      </div>
                      <div className="messages">
                        {s.messages
                          .filter((m) => m.conversationId === conversationId)
                          .map((m) => (
                            <div
                              className={`message ${m.authorId === "user" ? "mine" : ""}`}
                              key={m.id}
                            >
                              <small>
                                {m.authorId === "user"
                                  ? "我"
                                  : m.authorId === "system"
                                    ? "系统"
                                    : employee(m.authorId)?.name ||
                                      m.authorId}{" "}
                                · {date(m.createdAt)}
                              </small>
                              <div>{m.content}</div>
                            </div>
                          ))}
                      </div>
                      <form
                        className="composer"
                        onSubmit={submit(() => {
                          const prefixes = mentions
                            .map((id) => employee(id)?.name)
                            .filter((name): name is string => Boolean(name))
                            .filter((name) => !message.includes(`@${name}`));
                          const content = [
                            ...prefixes.map((name) => `@${name}`),
                            message,
                          ].join(" ");
                          void act(
                            `/api/conversations/${conversationId}/messages`,
                            "POST",
                            { id: crypto.randomUUID(), content, mentions },
                            () => {
                              setMessage("");
                              setMentions([]);
                            },
                          );
                        })}
                      >
                        <div className="mention-line">
                          <span>@ 参与成员</span>
                          {selectedConversation.memberIds.map((id) => (
                            <label key={id}>
                              <input
                                type="checkbox"
                                checked={mentions.includes(id)}
                                onChange={(e) =>
                                  setMentions(
                                    e.target.checked
                                      ? [...mentions, id]
                                      : mentions.filter((x) => x !== id),
                                  )
                                }
                              />
                              {employee(id)?.name || "未知员工"}
                            </label>
                          ))}
                        </div>
                        <textarea
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          placeholder="输入消息，明确你希望完成的事…"
                          required
                        />
                        <div>
                          <small>消息将发送至已配置的模型供应商。</small>
                          <button className="primary" disabled={busy}>
                            发送消息 ↑
                          </button>
                        </div>
                      </form>
                    </>
                  ) : (
                    <Empty
                      title="选择一个会话"
                      desc="在这里查看讨论和后台回复。"
                    />
                  )}
                </div>
              </div>
            </>
          )}
          {page === "交付物" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DELIVERABLES</div>
                  <h1>交付物</h1>
                  <p>查看任务结果，并由你决定是否验收。</p>
                </div>
              </div>
              {s.artifacts.length ? (
                <div className="artifact-list">
                  {s.artifacts.map((a) => {
                    const t = s.tasks.find((x) => x.id === a.taskId);
                    return (
                      <article className="panel" key={a.id}>
                        <div className="card-top">
                          <Badge tone={a.accepted ? "green" : "amber"}>
                            {a.accepted ? "已验收" : "待验收"}
                          </Badge>
                          <span className="muted">{date(a.createdAt)}</span>
                        </div>
                        <h3>{a.title}</h3>
                        <p className="muted">任务 · {t?.title || "未知任务"}</p>
                        <pre className="artifact-content">{a.content}</pre>
                        <small className="muted">摘要 {a.digest}</small>
                        {t?.state.kind === "review" && (
                          <div className="actions">
                            <button
                              className="primary"
                              onClick={() => action(t, "accept")}
                            >
                              确认验收
                            </button>
                            <button
                              onClick={() => {
                                setSelectedTask(t);
                                setModal("rework");
                              }}
                            >
                              要求重做
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <Empty
                  title="交付物会出现在这里"
                  desc="任务执行完成后，在这里查看结果并人工验收。"
                />
              )}
            </>
          )}
          {page === "设置" && <SettingsView snapshot={s} act={act} />}
        </main>
      </div>
      {modal && (
        <div
          className="overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              {
                task: "新建任务",
                employee: "员工资料",
                conversation: "新建会话",
                rule: "添加规则",
                approval: "确认执行范围",
                rework: "继续处理任务",
              }[modal]
            }
          >
            <div className="dialog-head">
              <h2>
                {
                  {
                    task: "新建任务",
                    employee: selectedEmployee ? "编辑员工" : "添加员工",
                    conversation: "新建会话",
                    rule: "添加关注规则",
                    approval: "确认执行范围",
                    rework:
                      selectedTask?.state.kind === "review"
                        ? "要求重做"
                        : "继续处理任务",
                  }[modal]
                }
              </h2>
              <button onClick={close} aria-label="关闭">
                ×
              </button>
            </div>
            {modal === "task" && (
              <form
                onSubmit={submit(
                  () =>
                    void act(
                      "/api/tasks",
                      "POST",
                      {
                        title: taskTitle,
                        instruction,
                        employeeId,
                        conversationId: null,
                        parentTaskId: null,
                        criteria: criteria
                          .split("\n")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      },
                      close,
                    ),
                )}
              >
                <p className="dialog-intro">
                  描述目标和验收标准，任务创建后仍需你批准才能执行。
                </p>
                <Field label="任务名称">
                  <input
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    required
                    maxLength={120}
                  />
                </Field>
                <Field label="指派员工">
                  <select
                    value={employeeId}
                    onChange={(e) => setEmployeeId(e.target.value)}
                    required
                  >
                    <option value="">选择员工</option>
                    {s.employees
                      .filter((e) => e.enabled)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} · {e.executor}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="任务说明">
                  <textarea
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    required
                    rows={5}
                  />
                </Field>
                <Field label="验收标准" help="每行一条，可留空。">
                  <textarea
                    value={criteria}
                    onChange={(e) => setCriteria(e.target.value)}
                    rows={3}
                  />
                </Field>
                <div className="dialog-actions">
                  <button type="button" onClick={close}>
                    取消
                  </button>
                  <button className="primary" disabled={busy}>
                    创建任务
                  </button>
                </div>
              </form>
            )}
            {modal === "employee" && (
              <form
                onSubmit={submit(
                  () =>
                    void act(
                      selectedEmployee
                        ? `/api/employees/${selectedEmployee.id}`
                        : "/api/employees",
                      selectedEmployee ? "PATCH" : "POST",
                      { name, role, executor, attentionMode },
                      close,
                    ),
                )}
              >
                <Field label="名称">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={40}
                    required
                  />
                </Field>
                <Field label="角色与职责">
                  <textarea
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    required
                    rows={3}
                  />
                </Field>
                <Field label="执行工具">
                  <select
                    value={executor}
                    onChange={(e) =>
                      setExecutor(e.target.value as typeof executor)
                    }
                  >
                    <option value="codex">Codex</option>
                    <option value="claude-code">Claude Code</option>
                  </select>
                </Field>
                <Field label="注意力">
                  <select
                    value={attentionMode}
                    onChange={(e) =>
                      setAttentionMode(e.target.value as typeof attentionMode)
                    }
                  >
                    <option value="auto">自动参与</option>
                    <option value="mentions">仅 @ 时参与</option>
                    <option value="muted">静默</option>
                  </select>
                </Field>
                <p className="note">
                  执行工具与对话模型是不同的配置。工具不可用时不会自动替换。
                </p>
                <div className="dialog-actions">
                  <button type="button" onClick={close}>
                    取消
                  </button>
                  <button className="primary" disabled={busy}>
                    保存员工
                  </button>
                </div>
              </form>
            )}
            {modal === "conversation" && (
              <form
                onSubmit={submit(
                  () =>
                    void act(
                      "/api/conversations",
                      "POST",
                      { title: conversationTitle, kind, memberIds: members },
                      close,
                    ),
                )}
              >
                <Field label="会话名称">
                  <input
                    value={conversationTitle}
                    onChange={(e) => setConversationTitle(e.target.value)}
                    required
                    maxLength={80}
                  />
                </Field>
                <Field label="会话类型">
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value as typeof kind);
                      setMembers([]);
                    }}
                  >
                    <option value="direct">私聊</option>
                    <option value="group">群聊</option>
                  </select>
                </Field>
                <div className="field">
                  <span>
                    参与员工{" "}
                    {kind === "direct" ? "（选择一人）" : "（最多 12 人）"}
                  </span>
                  <div className="check-list">
                    {s.employees
                      .filter((e) => e.enabled)
                      .map((e) => (
                        <label key={e.id}>
                          <input
                            type={kind === "direct" ? "radio" : "checkbox"}
                            name={kind === "direct" ? "member" : undefined}
                            checked={members.includes(e.id)}
                            onChange={(ev) =>
                              setMembers(
                                kind === "direct"
                                  ? [e.id]
                                  : ev.target.checked
                                    ? [...members, e.id]
                                    : members.filter((x) => x !== e.id),
                              )
                            }
                          />
                          {e.name} <small>{e.role}</small>
                        </label>
                      ))}
                  </div>
                </div>
                <div className="dialog-actions">
                  <button type="button" onClick={close}>
                    取消
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy || members.length === 0 || members.length > 12
                    }
                  >
                    创建会话
                  </button>
                </div>
              </form>
            )}
            {modal === "rule" && (
              <form
                onSubmit={submit(
                  () =>
                    void act(
                      "/api/rules",
                      "POST",
                      {
                        name: ruleName,
                        instruction: ruleInstruction,
                        employeeId,
                        intervalMinutes: interval,
                        mode: ruleMode,
                      },
                      () => {
                        setRuleName("");
                        setRuleInstruction("");
                        close();
                      },
                    ),
                )}
              >
                <Field label="规则名称">
                  <input
                    value={ruleName}
                    onChange={(e) => setRuleName(e.target.value)}
                    required
                  />
                </Field>
                <Field label="关注内容">
                  <textarea
                    value={ruleInstruction}
                    onChange={(e) => setRuleInstruction(e.target.value)}
                    required
                    rows={4}
                  />
                </Field>
                <Field label="负责员工">
                  <select
                    value={employeeId}
                    onChange={(e) => setEmployeeId(e.target.value)}
                    required
                  >
                    <option value="">选择员工</option>
                    {s.employees
                      .filter((e) => e.enabled)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="间隔（分钟）">
                  <input
                    type="number"
                    min={5}
                    max={10080}
                    value={interval}
                    onChange={(e) => setIntervalValue(Number(e.target.value))}
                  />
                </Field>
                <Field label="运行方式">
                  <select
                    value={ruleMode}
                    onChange={(e) =>
                      setRuleMode(e.target.value as typeof ruleMode)
                    }
                  >
                    <option value="observe">仅观察</option>
                    <option value="propose">提出待审批任务</option>
                  </select>
                </Field>
                <p className="note">规则不会自动批准或执行任务。</p>
                <div className="dialog-actions">
                  <button type="button" onClick={close}>
                    取消
                  </button>
                  <button className="primary" disabled={busy}>
                    保存规则
                  </button>
                </div>
              </form>
            )}
            {modal === "approval" && selectedTask && (
              <>
                <p className="dialog-intro">
                  批准只适用于当前任务的一次执行。请确认以下固定范围。
                </p>
                <div className="approval-box">
                  <div>
                    <span>任务</span>
                    <strong>{selectedTask.title}</strong>
                  </div>
                  <div>
                    <span>执行工具</span>
                    <strong>
                      {employee(selectedTask.employeeId)?.executor || "未知"}
                    </strong>
                  </div>
                  <div>
                    <span>执行模型</span>
                    <strong>
                      {employee(selectedTask.employeeId)?.executor === "codex"
                        ? s.settings.codexModel || "工具默认模型"
                        : "工具默认模型"}
                    </strong>
                  </div>
                  <div>
                    <span>专用目录</span>
                    <strong className="break">
                      {selectedTask.workspace || "未分配，无法批准"}
                    </strong>
                  </div>
                  <div>
                    <span>权限范围</span>
                    <strong>workspace-write</strong>
                  </div>
                  <div>
                    <span>有效期</span>
                    <strong>批准后 30 分钟</strong>
                  </div>
                </div>
                <p className="warning">
                  执行工具可在专用目录内修改文件，并可能调用外部服务。请先核对任务说明和目录。工具、模型或目录变化后需要重新审批。
                </p>
                <div className="dialog-actions">
                  <button onClick={close}>返回</button>
                  <button
                    className="primary"
                    disabled={busy || !selectedTask.workspace}
                    onClick={() => action(selectedTask, "approve")}
                  >
                    确认并批准
                  </button>
                </div>
              </>
            )}
            {modal === "rework" && selectedTask && (
              <form
                onSubmit={submit(() =>
                  action(
                    selectedTask,
                    selectedTask.state.kind === "review" ? "rework" : "resume",
                    input,
                  ),
                )}
              >
                <p className="dialog-intro">
                  {selectedTask.state.kind === "review"
                    ? "说明需要调整的内容。重做需要重新批准。"
                    : "补充信息后重新提交；恢复执行仍需重新批准。"}
                </p>
                <Field label="补充说明">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    rows={5}
                  />
                </Field>
                <div className="dialog-actions">
                  <button type="button" onClick={close}>
                    取消
                  </button>
                  <button className="primary" disabled={busy}>
                    提交
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type Act = (
  path: string,
  method: string,
  body: unknown,
  after?: () => void,
) => Promise<void>;
function ModelForm({
  purpose,
  snapshot,
  act,
}: {
  purpose: "main" | "attention";
  snapshot: Snapshot;
  act: Act;
}) {
  const current = snapshot.settings[purpose];
  const [provider, setProvider] = useState<ModelConfig["provider"]>(
    current?.provider || "deepseek",
  );
  const [endpoint, setEndpoint] = useState(
      current?.endpoint || PROVIDERS[0].endpoint,
    ),
    [model, setModel] = useState(current?.model || PROVIDERS[0].model),
    [thinking, setThinking] = useState(current?.thinking || false),
    [apiKey, setApiKey] = useState("");
  const changed =
    provider !== current?.provider || endpoint !== current?.endpoint;
  return (
    <form
      className="panel model-form"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          "/api/settings/model",
          "POST",
          {
            purpose,
            provider,
            endpoint,
            model,
            thinking,
            ...(apiKey ? { apiKey } : {}),
          },
          () => setApiKey(""),
        );
      }}
    >
      <div className="panel-heading">
        <div>
          <h2>{purpose === "main" ? "主会话模型" : "独立注意力模型"}</h2>
          <p>
            {purpose === "main"
              ? "用于员工会话与任务规划。"
              : "用于注意力判断，可选择复用主模型。"}
          </p>
        </div>
        {current?.hasKey && <Badge tone="green">已保存密钥</Badge>}
      </div>
      <div className="form-grid">
        <Field label="模型供应商">
          <select
            value={provider}
            onChange={(e) => {
              const p = PROVIDERS.find((x) => x.id === e.target.value)!;
              setProvider(p.id);
              setEndpoint(p.endpoint);
              setModel(p.model);
              setApiKey("");
            }}
          >
            {PROVIDERS.map((p) => (
              <option value={p.id} key={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="模型名称">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            required
            placeholder="输入供应商模型名称"
          />
        </Field>
        <Field label="HTTPS 服务地址">
          <input
            type="url"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              setApiKey("");
            }}
            required
            placeholder="https://..."
          />
        </Field>
        <Field
          label="API 密钥"
          help={
            changed
              ? "供应商或地址改变时需重新填写。"
              : current?.hasKey
                ? "留空以保留已保存的密钥。"
                : "密钥仅保存在本机，不会回显。"
          }
        >
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="new-password"
            required={changed || !current?.hasKey}
          />
        </Field>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={thinking}
          onChange={(e) => setThinking(e.target.checked)}
        />{" "}
        启用思考模式
      </label>
      <div className="actions">
        <button className="primary">
          保存{purpose === "main" ? "主模型" : "注意力模型"}
        </button>
      </div>
    </form>
  );
}
function SettingsView({ snapshot: s, act }: { snapshot: Snapshot; act: Act }) {
  const [maxWorkers, setMaxWorkers] = useState(s.settings.maxWorkers),
    [codexModel, setCodexModel] = useState(s.settings.codexModel),
    [attentionUseMain, setAttentionUseMain] = useState(
      s.settings.attentionUseMain,
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PREFERENCES</div>
          <h1>设置</h1>
          <p>配置模型和执行环境，掌握数据的去向。</p>
        </div>
      </div>
      <div className="privacy-note">
        <strong>关于数据与密钥</strong>
        <p>
          保存并启用模型配置或主动发送消息时，必要内容和凭据会发送给你选择的供应商。密钥仅存本机，不会在页面回显。
        </p>
      </div>
      <ModelForm purpose="main" snapshot={s} act={act} />
      <ModelForm purpose="attention" snapshot={s} act={act} />
      <form
        className="panel model-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act("/api/settings/execution", "POST", {
            maxWorkers,
            codexModel,
            attentionUseMain,
          });
        }}
      >
        <div className="panel-heading">
          <div>
            <h2>执行与注意力</h2>
            <p>任务执行器和会话模型分别配置。</p>
          </div>
        </div>
        <div className="form-grid">
          <Field label="并发任务数">
            <input
              type="number"
              min={1}
              max={4}
              value={maxWorkers}
              onChange={(e) => setMaxWorkers(Number(e.target.value))}
            />
          </Field>
          <Field label="Codex 执行模型" help="留空使用工具默认值。">
            <input
              value={codexModel}
              onChange={(e) => setCodexModel(e.target.value)}
            />
          </Field>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={attentionUseMain}
            onChange={(e) => setAttentionUseMain(e.target.checked)}
          />{" "}
          注意力复用主模型
        </label>
        <div className="actions">
          <button className="primary">保存执行设置</button>
        </div>
      </form>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>执行工具状态</h2>
            <p>不可用时不会静默切换工具。</p>
          </div>
        </div>
        {s.executors.map((e) => (
          <div className="list-row" key={e.executor}>
            <span className="grow">
              <strong>{e.executor}</strong>
              <small>{e.detail}</small>
            </span>
            <Badge tone={e.available ? "green" : "red"}>
              {e.available ? "可用" : "不可用"}
            </Badge>
          </div>
        ))}
      </section>
    </>
  );
}
export default App;
