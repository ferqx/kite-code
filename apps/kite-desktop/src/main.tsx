import { confirm } from '@tauri-apps/plugin-dialog';
import { useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopClient } from './client';
import { Interaction } from './Interaction';
import { Results } from './Results';
import { Settings } from './Settings';
import './style.css';

const client = new DesktopClient();
const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待交互',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  recovery_required: '需要恢复',
};

function App() {
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = `${view.workspace}\0${view.selected ?? ''}`;
  const draft = drafts[draftKey] ?? '';
  const runStatus = view.projection?.currentRun?.status;
  const active = runStatus === 'running' || runStatus === 'waiting' || runStatus === 'queued';
  const interaction = view.projection?.interactionQueue.interactions.find(
    (item) => item.interactionId === view.projection?.interactionQueue.activeInteractionId,
  );
  const act = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    client.clearError();
    try {
      await action();
    } catch (error) {
      client.report(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="mark">K</span>
          <strong>Kite Code</strong>
          <small>DESKTOP</small>
        </div>
        <button
          type="button"
          className="project"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              if (view.connected) {
                if (
                  !(await confirm('切换项目将先停止当前连接的任务并等待清理，已有修改不会撤销。', {
                    title: '切换项目？',
                    kind: 'warning',
                    okLabel: '停止并选择项目',
                    cancelLabel: '留在当前项目',
                  }))
                )
                  return;
                await client.disconnect();
              }
              await client.openProject();
            })
          }
        >
          <span>{view.connected ? '切换项目' : '项目'}</span>
          <strong>{view.workspace.split('/').filter(Boolean).pop() || '打开本地项目'}</strong>
          <span>⌘</span>
        </button>
        <button
          type="button"
          className="new-session"
          disabled={busy || !view.connected || view.trust?.status !== 'trusted'}
          onClick={() => void act(() => client.newSession())}
        >
          ＋ 新建会话
        </button>
        <div className="nav-label">
          会话{' '}
          <button
            type="button"
            disabled={busy || !view.connected}
            onClick={() => void act(() => client.refreshSessions())}
            aria-label="刷新会话"
          >
            ↻
          </button>
        </div>
        <nav>
          {view.sessions.map((session) => (
            <button
              type="button"
              className={view.selected === session.sessionId ? 'selected' : ''}
              key={session.sessionId}
              disabled={busy}
              onClick={() => void act(() => client.selectSession(session.sessionId))}
            >
              {session.displayName || '新会话'}
            </button>
          ))}
        </nav>
        <div className="connection">
          <span className={view.connected ? 'dot online' : 'dot'} />
          {view.connected ? '本地服务已连接' : '未连接'}
          {view.workspace && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (view.connected) {
                    if (
                      !(await confirm('断开会停止本应用在此项目中的任务，已有修改不会撤销。', {
                        title: '断开项目？',
                        kind: 'warning',
                        okLabel: '停止并断开',
                        cancelLabel: '返回',
                      }))
                    )
                      return;
                    await client.disconnect();
                  } else await client.connect();
                })
              }
            >
              {view.connected ? '断开' : '重连'}
            </button>
          )}
        </div>
      </aside>
      <main>
        <header>
          <div>
            <strong>
              {view.sessions.find((session) => session.sessionId === view.selected)?.displayName ||
                '开始一项工作'}
            </strong>
            <p>{view.workspace || '在你的项目中理解、修改与验证代码'}</p>
          </div>
          <span className="status">
            {view.connected ? (runStatus ? statusLabels[runStatus] : '就绪') : '离线'}
          </span>
        </header>
        {view.error && (
          <div className="notice error" role="alert">
            {view.error}
          </div>
        )}
        {view.trust && view.trust.status !== 'trusted' && (
          <section className="notice">
            <strong>信任此项目？</strong>
            <p>确认后，Agent 可以在工作区中读取与修改文件；具体工具仍遵循执行授权。</p>
            <code>{view.trust.workspace.canonicalPath}</code>
            {view.trust.externalReadScope.roots.length > 0 && (
              <p>关联外部只读目录：{view.trust.externalReadScope.roots.join('、')}</p>
            )}
            <button
              type="button"
              disabled={busy || !view.trust.canDecide}
              onClick={() => void act(() => client.trustProject())}
            >
              信任并继续
            </button>
          </section>
        )}
        <section className="conversation" aria-live="polite">
          <Settings key={view.workspace} client={client} view={view} busy={busy} act={act} />
          {view.selected && <Results client={client} view={view} busy={busy} act={act} />}
          {view.loadingSession ? (
            <div className="notice" role="status">
              正在加载会话…
            </div>
          ) : view.messages.length === 0 ? (
            <div className="welcome">
              <span className="eyebrow">YOUR LOCAL WORKSPACE</span>
              <h1>
                把想法变成
                <br />
                <em>下一步行动。</em>
              </h1>
              <p>
                {view.connected
                  ? '新建或选择一个会话，开始你的开发任务。'
                  : '选择一个本地项目，连接你的模型与工具。'}
              </p>
              {!view.workspace && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void act(() => client.openProject())}
                >
                  打开项目 ↗
                </button>
              )}
            </div>
          ) : (
            view.messages
              .filter((message) => !message.settled || message.text.length > 0)
              .map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div className="message-label">
                    {message.role === 'user'
                      ? '你'
                      : message.role === 'assistant'
                        ? 'Kite'
                        : '工具'}
                    {!message.settled && <span className="live"> · 进行中</span>}
                  </div>
                  <pre>{message.text || '正在思考…'}</pre>
                </article>
              ))
          )}
          {interaction?.kind === 'approval' && view.selected ? (
            <section className="notice" aria-label="工具审批">
              <strong>{interaction.title || '工具需要你的批准'}</strong>
              <p>{interaction.summary}</p>
              {interaction.command && (
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {interaction.command}
                </pre>
              )}
              <button
                type="button"
                disabled={busy || !view.ready}
                onClick={() =>
                  void act(() => client.respondApproval(view.selected!, interaction, 'reject'))
                }
              >
                拒绝
              </button>
              <button
                type="button"
                disabled={busy || !view.ready || !interaction.grants.includes('approve_once')}
                onClick={() =>
                  void act(() =>
                    client.respondApproval(view.selected!, interaction, 'approve_once'),
                  )
                }
              >
                仅批准这一次
              </button>
            </section>
          ) : (interaction?.kind === 'input' || interaction?.kind === 'plan_review') &&
            view.selected ? (
            <Interaction
              key={`${view.workspace}:${view.selected}:${interaction.interactionId}`}
              client={client}
              sessionId={view.selected}
              interaction={interaction}
              disabled={busy || !view.ready}
              act={act}
            />
          ) : (
            runStatus === 'waiting' && (
              <div className="notice">
                任务正在等待尚未支持的扩展或验证交互，可以取消任务并检查结果。
              </div>
            )
          )}
        </section>
        <footer>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const submitted = draft;
              void act(async () => {
                await client.send(submitted);
                setDrafts((values) => ({
                  ...values,
                  [draftKey]: values[draftKey] === submitted ? '' : (values[draftKey] ?? ''),
                }));
              });
            }}
          >
            <textarea
              aria-label="任务输入"
              placeholder="描述你希望完成的任务…"
              value={draft}
              onChange={(event) =>
                setDrafts((values) => ({ ...values, [draftKey]: event.target.value }))
              }
              disabled={!view.selected}
            />
            <div className="composer-bottom">
              <span>
                {view.models?.selected
                  ? `${view.models.selected.provider} / ${view.models.selected.name}`
                  : '模型使用已有本地配置'}
              </span>
              {active ? (
                <button
                  type="button"
                  disabled={busy || !view.ready}
                  onClick={() => void act(() => client.cancel())}
                >
                  停止任务 ■
                </button>
              ) : (
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    busy ||
                    !view.connected ||
                    !view.ready ||
                    !draft.trim() ||
                    view.trust?.status !== 'trusted'
                  }
                >
                  发送 ↑
                </button>
              )}
            </div>
          </form>
          <p className="hint">关闭窗口后任务继续 · 退出应用会停止任务 · 取消不会撤销已有修改</p>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
