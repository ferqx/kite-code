import { useEffect, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeSelection,
  NativeSessionFacts,
  NativeSessionSubmission,
} from './native-bridge';

export function NativeSessionPanel({
  bridge,
  generation,
  selection,
  submissions,
  onRefresh,
  onSelect,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  submissions: readonly NativeSessionSubmission[];
  onRefresh: () => Promise<unknown>;
  onSelect: (sessionId: string) => Promise<unknown>;
}) {
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const current = useRef(identity);
  current.current = identity;
  const [facts, setFacts] = useState<NativeSessionFacts>(),
    [title, setTitle] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const flight = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A scope change clears the old observation without requiring a remount.
  useEffect(() => {
    setFacts(undefined);
    setTitle('');
    setConfirmed(false);
    setError('');
  }, [identity]);
  useEffect(() => {
    if (selection?.permissionUnavailable && !selection.viewLoading) setFacts(undefined);
  }, [selection?.permissionUnavailable, selection?.viewLoading]);
  const unresolved = submissions.some((entry) =>
    ['saved', 'submitting', 'unknown'].includes(entry.phase),
  );
  const readonly =
    !selection ||
    selection.permissionUnavailable ||
    selection.session.parentSessionId !== null ||
    selection.session.deletedAt !== null;
  async function action(run: () => Promise<unknown>, refresh = false) {
    if (flight.current) return;
    const original = identity;
    flight.current = true;
    setPending(true);
    setError('');
    try {
      await run();
    } catch (cause) {
      if (current.current === original) {
        const code =
          (cause as { code?: string; message?: string }).code ?? (cause as Error).message;
        setError(/^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code! : 'session_unavailable');
      }
    } finally {
      flight.current = false;
      setPending(false);
      if (refresh) {
        if (current.current === original) {
          setFacts(undefined);
          setConfirmed(false);
        }
        await onRefresh();
      }
    }
  }
  return (
    <section aria-label="会话管理">
      {selection && (
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void action(async () => {
                setFacts(undefined);
                const original = identity,
                  result = await bridge.request({
                    method: 'session.observe',
                    generation,
                    sessionId: selection.session.id,
                  });
                if (current.current !== original) return;
                if (
                  !result ||
                  !('observationId' in result) ||
                  !('session' in result) ||
                  result.session.id !== selection.session.id
                )
                  throw Error('session_scope_mismatch');
                setFacts(result);
                setTitle(result.session.title);
              })
            }
          >
            读取当前会话管理事实
          </button>
          {readonly && <p>当前会话管理只读；子会话继承关系与已删除历史不在这里修改。</p>}
          {facts && (
            <>
              <p>
                原会话 {facts.session.id} · 原存储 {selection.storeId} · 控制修订{' '}
                {facts.session.controlRevision} · 上下文 {facts.session.contextSelectionId}
              </p>
              <label>
                会话名称
                <input
                  aria-label="会话管理名称"
                  value={title}
                  disabled={pending || unresolved || readonly}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              {!readonly && (
                <>
                  <button
                    type="button"
                    disabled={pending || unresolved || !title.trim()}
                    onClick={() =>
                      void action(
                        () =>
                          bridge.request({
                            method: 'session.rename',
                            generation,
                            observationId: facts.observationId,
                            title,
                          }),
                        true,
                      )
                    }
                  >
                    保存当前会话名称
                  </button>
                  {selection.canReadContext && (
                    <>
                      <p>分叉复制当前所选历史；扩展状态默认不复制，不重放已有执行。</p>
                      <button
                        type="button"
                        disabled={pending || unresolved || !title.trim()}
                        onClick={() =>
                          void action(
                            () =>
                              bridge.request({
                                method: 'session.fork',
                                generation,
                                observationId: facts.observationId,
                                title,
                              }),
                            true,
                          )
                        }
                      >
                        从当前所选上下文分叉
                      </button>
                    </>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={pending || unresolved}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    我确认删除此会话；服务请求取消并继续收尾，工作区文件不受影响
                  </label>
                  <p>
                    删除先隐藏会话并请求停止任务。退出客户端后的离线维护可在宽限期后清理历史正文；未结束或结果未知的执行、存活分支依赖的来源会继续保留。
                  </p>
                  <button
                    type="button"
                    disabled={pending || unresolved || !confirmed}
                    onClick={() =>
                      void action(
                        () =>
                          bridge.request({
                            method: 'session.delete',
                            generation,
                            observationId: facts.observationId,
                          }),
                        true,
                      )
                    }
                  >
                    删除当前会话
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
      {error && <p role="alert">会话操作未确认：{error}。请保留原意图并核实；不会重新提交。</p>}
      {submissions.map((entry) => (
        <div key={entry.intent.commandId}>
          <p>
            原会话 {entry.sessionId} · 原存储 {entry.intent.expectedStoreId} · 原命令{' '}
            {entry.intent.commandId} · {entry.kind}：{entry.phase}
            {entry.error ? ` · ${entry.error}` : ''}
          </p>
          {entry.omittedExtensionState && <p>分叉已确认；扩展状态未复制。</p>}
          {entry.kind === 'delete' && entry.phase === 'applied' && (
            <p>已请求删除；尚未确认所有执行资源停止。</p>
          )}
          {entry.kind === 'fork' && entry.phase === 'applied' && entry.newSessionId && (
            <button type="button" onClick={() => void onSelect(entry.newSessionId!)}>
              打开已确认分叉
            </button>
          )}
          {entry.phase === 'unknown' && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void action(
                  () =>
                    bridge.request({
                      method: 'lookupSessionMutation',
                      generation,
                      commandId: entry.intent.commandId,
                    }),
                  true,
                )
              }
            >
              查询原会话操作
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
