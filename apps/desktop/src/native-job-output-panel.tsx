import type { ExecutionOutputPage } from '@kite-ai/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeJobOutputScope, NativeSelection } from './native-bridge';
import { readNativeJobOutput } from './native-job-output';

const safeError = (cause: unknown) => {
  const code = (cause as { code?: string; message?: string })?.code ?? (cause as Error)?.message;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(code)
    ? code
    : 'job_output_unavailable';
};

export function NativeJobOutputPanel(
  props: {
    bridge: NativeBridge;
    generation: number;
    executionId: string;
  } & (
    | { selection: NativeSelection; historyEpoch: number }
    | { backgroundScope: NativeJobOutputScope }
  ),
) {
  const { bridge, generation, executionId } = props;
  const background = 'backgroundScope' in props;
  const storeId = background ? props.backgroundScope.storeId : props.selection.storeId,
    sessionId = background ? props.backgroundScope.sessionId : props.selection.session.id,
    workspaceId = background
      ? props.backgroundScope.workspaceId
      : props.selection.session.workspaceId,
    viewSelection = background
      ? props.backgroundScope.viewSelection
      : (props.selection.viewSelection ?? 0),
    historyEpoch = background ? 0 : props.historyEpoch;
  const scope: NativeJobOutputScope = useMemo(
    () => ({
      generation,
      viewSelection,
      historyEpoch,
      storeId,
      sessionId,
      workspaceId,
      executionId,
    }),
    [generation, viewSelection, historyEpoch, storeId, sessionId, workspaceId, executionId],
  );
  const identity = JSON.stringify(background ? { ...scope, viewSelection: 0 } : scope);
  const target = useRef(scope);
  target.current = scope;
  const [opened, setOpened] = useState(''),
    [refresh, setRefresh] = useState(0),
    [view, setView] = useState<{
      identity: string;
      facts?: ExecutionOutputPage;
      busy: boolean;
      error?: string;
    }>({ identity, busy: false });
  const readIdentity = `${identity}/${refresh}`,
    current = useRef(readIdentity);
  current.current = readIdentity;
  const isOpen = opened === identity,
    facts = view.identity === identity ? view.facts : undefined,
    error = view.identity === identity ? view.error : undefined,
    busy = view.identity === identity && view.busy;
  useEffect(() => {
    if (!isOpen) return;
    const abort = new AbortController();
    setView((old) => ({
      identity,
      facts: old.identity === identity ? old.facts : undefined,
      busy: true,
    }));
    void readNativeJobOutput({
      bridge,
      scope: target.current,
      background,
      signal: abort.signal,
      isCurrent: () => current.current === readIdentity,
    })
      .then((value) => {
        if (!abort.signal.aborted && current.current === readIdentity)
          setView({ identity, facts: value, busy: false });
      })
      .catch((cause) => {
        if (!abort.signal.aborted && current.current === readIdentity)
          setView((old) => ({
            identity,
            facts: old.identity === identity ? old.facts : undefined,
            busy: false,
            error: safeError(cause),
          }));
      });
    return () => abort.abort();
  }, [bridge, background, identity, readIdentity, isOpen]);
  return (
    <section aria-label={`Job 已保存输出 · ${executionId}`}>
      {!isOpen ? (
        <button type="button" onClick={() => setOpened(identity)}>
          读取完整已保存输出
        </button>
      ) : (
        <>
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>
            刷新已保存输出
          </button>
          <button
            type="button"
            onClick={() => {
              setOpened('');
              setView({ identity, busy: false });
            }}
          >
            关闭输出
          </button>
          {busy && <p role="status">正在读取完整已保存输出…</p>}
          {error && (
            <p role="alert">
              输出读取失败：{error}。
              {facts ? '保留上次完整内容，尚未确认最新输出。' : '尚未取得完整内容。'}
            </p>
          )}
          {facts && (
            <>
              <p>已完整读取截至输出序号 {facts.highWaterSeq} 的已保存内容。</p>
              {busy && <p>当前显示上次完整内容，正在核对最新输出。</p>}
              {!facts.items.length ? (
                <p>此 Job 尚无已保存输出。</p>
              ) : (
                <ol aria-label="已保存输出记录">
                  {facts.items.map((item) => {
                    const gap =
                      item.droppedBytes === null ||
                      item.droppedBytes !== '0' ||
                      item.seq !== item.throughSeq;
                    return (
                      <li
                        key={`${item.stream}/${item.seq}/${item.throughSeq}`}
                        data-stream={item.stream}
                      >
                        <p>
                          {item.stream} · 输出序号 {item.seq}
                          {item.seq !== item.throughSeq ? `–${item.throughSeq}` : ''}
                        </p>
                        {gap ? (
                          <p>
                            输出缺口：
                            {item.droppedBytes === null
                              ? '此区间丢失字节数无法确定'
                              : `丢失 ${item.droppedBytes} 字节`}
                            。
                          </p>
                        ) : (
                          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            {item.content}
                          </pre>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              <p>完整范围包含服务保存的内容和已记录缺口；丢失的输出无法恢复。新输出需显式刷新。</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
