import type { BackgroundExecutionItem } from '@kite-ai/client';
import { useEffect, useRef, useState } from 'react';
import type { NativeBackgroundChild } from './background-bridge';
import { readNativeBackground, readNativeBackgroundChild } from './native-background';
import type { NativeBridge } from './native-bridge';
import { NativeJobOutputPanel } from './native-job-output-panel';

const safeError = (cause: unknown) => {
  const code = (cause as { code?: string; message?: string })?.code ?? (cause as Error)?.message;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(code)
    ? code
    : 'background_unavailable';
};

type NativeBackgroundPanelProps = {
  bridge: NativeBridge;
  generation: number;
  storeId: string;
  unavailable: boolean;
  onChanged: () => Promise<void>;
};

export function NativeBackgroundPanel(props: NativeBackgroundPanelProps) {
  return <BackgroundPanel key={JSON.stringify([props.generation, props.storeId])} {...props} />;
}

function BackgroundPanel({
  bridge,
  generation,
  storeId,
  unavailable,
  onChanged,
}: NativeBackgroundPanelProps) {
  const [opened, setOpened] = useState(false),
    [refresh, setRefresh] = useState(0),
    [view, setView] = useState<{
      items?: BackgroundExecutionItem[];
      observationId?: number;
      busy: boolean;
      error?: string;
    }>({ busy: false }),
    [stopping, setStopping] = useState<string>(),
    [stopError, setStopError] = useState(''),
    [accepted, setAccepted] = useState('');
  const epoch = useRef(0);
  const activeStop = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh reopens the same observation without changing its scope.
  useEffect(() => {
    if (!opened) return;
    const abort = new AbortController(),
      current = ++epoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (activeStop.current) return;
      setView((old) => ({ ...old, busy: true, error: undefined }));
      try {
        const facts = await readNativeBackground({
          bridge,
          generation,
          storeId,
          signal: abort.signal,
          isCurrent: () => epoch.current === current,
        });
        if (!abort.signal.aborted && epoch.current === current) setView({ ...facts, busy: false });
      } catch (cause) {
        if (!abort.signal.aborted && epoch.current === current)
          setView((old) => ({ ...old, busy: false, error: safeError(cause) }));
      }
      if (!abort.signal.aborted && epoch.current === current)
        timer = setTimeout(() => {
          void read();
        }, 1000);
    };
    void read();
    return () => {
      epoch.current++;
      clearTimeout(timer);
      abort.abort();
    };
  }, [bridge, generation, storeId, opened, refresh]);
  return (
    <section aria-label="后台总览">
      <h2>后台总览</h2>
      {!opened ? (
        <button type="button" onClick={() => setOpened(true)}>
          打开后台总览
        </button>
      ) : (
        <>
          <button type="button" onClick={() => setRefresh((n) => n + 1)}>
            刷新后台总览
          </button>
          <button
            type="button"
            onClick={() => {
              setOpened(false);
              setView({ busy: false });
            }}
          >
            关闭后台总览
          </button>
          <p>显示原会话的全部已保存后台执行，切换会话后继续观察。执行与子轮次的状态分别显示。</p>
          {view.busy && <p role="status">正在核对完整后台目录…</p>}
          {(view.error || unavailable) && (
            <p role="alert">
              后台目录尚未更新：{view.error ?? '连接观察不可用'}
              。保留上次完整事实，停止入口暂不可用。
            </p>
          )}
          {view.items && (
            <p role="status">
              后台目录已完整读取，共 {view.items.length} 项。
              {view.busy ? '正在刷新，当前显示上次完整事实。' : ''}
            </p>
          )}
          {view.items?.length === 0 && <p>此主体尚无已保存后台执行。</p>}
          {stopError && <p role="alert">原停止请求：{stopError}。请在原申请面板核实原命令。</p>}
          {accepted && (
            <p role="status">停止请求已受理：{accepted}；实际执行和清理仍以随后状态为准。</p>
          )}
          {view.items?.map((item) => {
            const e = item.execution,
              stoppable =
                !view.busy &&
                !view.error &&
                !unavailable &&
                !!view.observationId &&
                ['planned', 'dispatching', 'running'].includes(e.status) &&
                !e.cancelRequested &&
                e.cancelRequestedAt === null;
            return (
              <article
                key={`${generation}/${storeId}/${e.id}`}
                aria-label={`后台执行 · ${e.id}`}
                data-execution-id={e.id}
              >
                <p>
                  {e.childSessionId ? '子 Agent' : 'Job'} · {e.definitionId} · {e.status}
                  {e.cancelRequested ? ' · 停止已请求' : ''}
                </p>
                <p>
                  原会话 {item.rootSession.title} · {item.rootSession.id} · 工作区{' '}
                  {item.session.workspaceId}
                </p>
                <p>
                  原执行 {e.id} · 来源会话 {e.sessionId} · 原命令 {e.originCommandId} · 尝试{' '}
                  {e.attempt}
                </p>
                {item.run && (
                  <p>
                    原父轮次 {item.run.id} · {item.run.status}
                    {item.run.reason ? ` · ${item.run.reason}` : ''}
                    {item.run.waitingForResults.includes(e.id) ? ' · 本轮必需任务' : ''}
                  </p>
                )}
                {e.childSessionId && (
                  <p>
                    子会话 {e.childSessionId} · 原子轮次{' '}
                    {item.childRun ? `${item.childRun.id} · ${item.childRun.status}` : '尚未确认'}
                  </p>
                )}
                {e.delivery && (
                  <p>
                    结果接纳：{e.delivery}
                    {e.deliveryReason ? ` · ${e.deliveryReason}` : ''}
                  </p>
                )}
                {stoppable && (
                  <button
                    type="button"
                    disabled={!!stopping}
                    onClick={() => {
                      const observationId = view.observationId!;
                      activeStop.current = true;
                      setStopping(e.id);
                      setStopError('');
                      setAccepted('');
                      void bridge
                        .request({
                          method: 'background.stop',
                          generation,
                          observationId,
                          executionId: e.id,
                          commandId: crypto.randomUUID(),
                        })
                        .then((result) => {
                          if (result && 'status' in result && result.status === 'applied')
                            setAccepted(e.id);
                          else setStopError('caller_receipt_unavailable');
                        })
                        .catch((cause) => setStopError(safeError(cause)))
                        .finally(() => {
                          activeStop.current = false;
                          setStopping(undefined);
                          setRefresh((n) => n + 1);
                          void onChanged();
                        });
                    }}
                  >
                    停止后台执行 · {e.id}
                  </button>
                )}
                {view.observationId && (
                  <NativeJobOutputPanel
                    bridge={bridge}
                    generation={generation}
                    executionId={e.id}
                    backgroundScope={{
                      generation,
                      viewSelection: view.observationId,
                      historyEpoch: 0,
                      storeId,
                      sessionId: item.session.id,
                      workspaceId: item.session.workspaceId,
                      executionId: e.id,
                    }}
                  />
                )}
                {e.childSessionId && view.observationId && (
                  <BackgroundChildPanel
                    bridge={bridge}
                    generation={generation}
                    storeId={storeId}
                    observationId={view.observationId}
                    item={item}
                  />
                )}
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}

function BackgroundChildPanel({
  bridge,
  generation,
  storeId,
  observationId,
  item,
}: {
  bridge: NativeBridge;
  generation: number;
  storeId: string;
  observationId: number;
  item: BackgroundExecutionItem;
}) {
  const [opened, setOpened] = useState(false),
    [refresh, setRefresh] = useState(0),
    [view, setView] = useState<{ facts?: NativeBackgroundChild; busy: boolean; error?: string }>({
      busy: false,
    });
  const target = useRef({ item, observationId });
  target.current = { item, observationId };
  const executionId = item.execution.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh and original carrier changes reopen the detail, directory polls do not.
  useEffect(() => {
    if (!opened) return;
    const abort = new AbortController();
    setView((old) => ({ ...old, busy: true, error: undefined }));
    void readNativeBackgroundChild({
      bridge,
      generation,
      storeId,
      ...target.current,
      signal: abort.signal,
      isCurrent: () => !abort.signal.aborted,
    })
      .then((facts) => {
        if (!abort.signal.aborted) setView({ facts, busy: false });
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setView((old) => ({ ...old, busy: false, error: safeError(cause) }));
      });
    return () => abort.abort();
  }, [bridge, generation, storeId, executionId, opened, refresh]);
  return (
    <section aria-label={`子 Agent 完整日志 · ${executionId}`}>
      {!opened ? (
        <button type="button" onClick={() => setOpened(true)}>
          读取完整子日志
        </button>
      ) : (
        <>
          <button type="button" onClick={() => setRefresh((n) => n + 1)}>
            刷新子日志
          </button>
          <button
            type="button"
            onClick={() => {
              setOpened(false);
              setView({ busy: false });
            }}
          >
            关闭子日志
          </button>
          {view.busy && <p role="status">正在读取完整子会话日志…</p>}
          {view.error && (
            <p role="alert">
              子日志读取失败：{view.error}。
              {view.facts ? '保留上次完整内容，尚未更新。' : '尚未取得完整内容。'}
            </p>
          )}
          {view.facts && (
            <>
              <p>
                已完整读取子会话 {view.facts.session.id} 截至序号 {view.facts.upperSeq}{' '}
                的日志。原任务对应子轮次 {view.facts.item.childRun?.id ?? '尚未确认'}。
              </p>
              <p>日志只读；同一子会话中的后续轮次保留各自身份，不改变原任务。</p>
              {view.facts.messages.map((message) => {
                const output = view.facts!.modelOutputs.find(
                  (entry) => entry.messageId === message.id,
                )?.snapshot;
                return (
                  <article key={message.id} aria-label={`子消息 · ${message.id}`}>
                    <small>
                      {message.role} · {message.seq} · 轮次 {message.runId ?? '未记录'}
                    </small>
                    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {output?.output.content ?? message.content}
                    </pre>
                    {output?.output.reasoning && (
                      <details>
                        <summary>推理记录</summary>
                        <pre style={{ whiteSpace: 'pre-wrap' }}>{output.output.reasoning}</pre>
                      </details>
                    )}
                    {(output?.output.toolCalls ?? message.toolCalls)?.map((call) => (
                      <pre key={call.id}>{JSON.stringify(call, null, 2)}</pre>
                    ))}
                    {output && !output.output.complete && <p>原模型输出不完整。</p>}
                    {message.contentFormat === 'unsupported' && <p>原正文不可用。</p>}
                  </article>
                );
              })}
            </>
          )}
        </>
      )}
    </section>
  );
}
