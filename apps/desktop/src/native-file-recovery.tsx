import type { FileCheckpointPage } from '@kite-ai/client';
import type { FileRecoveryIntent } from '@kite-ai/client/file-recovery-intent';
import { useEffect, useRef, useState } from 'react';
import type { NativeBridge, NativeFileRecoveryObservation, NativeSelection } from './native-bridge';

export function NativeFileRecoveryPanel({
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
  submissions: readonly FileRecoveryIntent[];
  onRefresh: () => Promise<unknown>;
  onSelect: (id: string) => Promise<unknown>;
}) {
  const identity = JSON.stringify([
    generation,
    selection?.viewSelection,
    selection?.storeId,
    selection?.session.id,
    selection?.session.contextSelectionId,
    selection?.session.controlRevision,
  ]);
  const current = useRef(identity);
  current.current = identity;
  const read = useRef<string | undefined>(undefined),
    revision = useRef(0),
    flight = useRef(false);
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<FileCheckpointPage>(),
    [facts, setFacts] = useState<NativeFileRecoveryObservation>(),
    [scope, setScope] = useState<FileRecoveryIntent['scope']>('session'),
    [title, setTitle] = useState('恢复的会话'),
    [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  function cancel() {
    const id = read.current;
    read.current = undefined;
    revision.current++;
    setFacts(undefined);
    setConfirmed(false);
    if (id)
      void bridge.request({ method: 'fileRecovery.close', generation, readId: id }).catch(() => {});
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Current observation authority changes with this full identity.
  useEffect(() => {
    cancel();
    setPage(undefined);
    setError('');
    return () => {
      const id = read.current;
      read.current = undefined;
      if (id)
        void bridge
          .request({ method: 'fileRecovery.close', generation, readId: id })
          .catch(() => {});
    };
  }, [identity]);
  const readonly =
    !selection ||
    selection.permissionUnavailable ||
    selection.viewLoading ||
    selection.session.parentSessionId !== null ||
    selection.session.deletedAt !== null;
  async function action(run: () => Promise<unknown>, mutation = false) {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setError('');
    const original = current.current;
    try {
      await run();
    } catch (cause) {
      if (current.current === original) {
        const code =
          (cause as { code?: string; message?: string }).code ?? (cause as Error).message;
        setError(/^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code! : 'file_recovery_unavailable');
      }
    } finally {
      flight.current = false;
      if (current.current === original) setPending(false);
      if (mutation) await onRefresh();
    }
  }
  async function list(afterKey?: string) {
    cancel();
    const id = crypto.randomUUID();
    read.current = id;
    const original = current.current;
    const value = await bridge.request({
      method: 'fileRecovery.list',
      generation,
      readId: id,
      ...(afterKey ? { afterKey } : {}),
    });
    if (
      current.current === original &&
      read.current === id &&
      value &&
      'payload' in value &&
      'items' in value.payload
    )
      setPage(value as FileCheckpointPage);
  }
  async function detail(pointId: string) {
    cancel();
    const id = crypto.randomUUID();
    read.current = id;
    const original = current.current,
      value = await bridge.request({
        method: 'fileRecovery.detail',
        generation,
        readId: id,
        pointId,
        inputRevision: revision.current,
      });
    if (
      current.current === original &&
      read.current === id &&
      value &&
      'kind' in value &&
      value.kind === 'fileRecovery.observation' &&
      'detail' in value &&
      'boundary' in value
    )
      setFacts(value);
  }
  return (
    <section aria-label="文件检查点恢复">
      <button
        type="button"
        onClick={() => {
          cancel();
          setOpen(!open);
        }}
      >
        文件检查点
      </button>
      {open && (
        <>
          <button
            type="button"
            disabled={readonly || pending}
            onClick={() => void action(() => list())}
          >
            读取检查点
          </button>
          {page?.payload.items.map((item) => (
            <button
              type="button"
              key={item.checkpoint.id}
              disabled={readonly || pending}
              onClick={() => void action(() => detail(item.checkpoint.id))}
            >
              检查点 {item.checkpoint.id}
            </button>
          ))}
          {page?.payload.nextAfterKey && (
            <button
              type="button"
              disabled={readonly || pending}
              onClick={() => void action(() => list(page.payload.nextAfterKey!))}
            >
              下一页
            </button>
          )}
          <label>
            恢复范围
            <select
              aria-label="恢复范围"
              value={scope}
              onChange={(event) => {
                cancel();
                setScope(event.target.value as FileRecoveryIntent['scope']);
              }}
            >
              <option value="session">仅会话</option>
              <option value="code">仅代码</option>
              <option value="both">代码与会话</option>
            </select>
          </label>
          <label>
            新会话标题
            <input
              aria-label="恢复会话标题"
              value={title}
              onChange={(event) => {
                cancel();
                setTitle(event.target.value);
              }}
            />
          </label>
          {facts && (
            <div>
              <p>
                当前来源 {facts.boundary.sessionId} · 选择 {facts.boundary.contextSelectionId}
              </p>
              <p>
                原检查点 {facts.boundary.checkpoint.boundary.storeId}/
                {facts.boundary.checkpoint.boundary.sessionId}
              </p>
              {facts.detail.payload.files.map((file) => (
                <p key={file.path}>
                  {file.path} · {file.status}
                  {file.reason ? ` · ${file.reason}` : ''}
                </p>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                确认当前范围与检查点
              </label>
              <button
                type="button"
                disabled={readonly || pending || !confirmed || !title.trim()}
                onClick={() =>
                  void action(async () => {
                    const original = current.current,
                      input = revision.current;
                    const value = await bridge.request({
                      method: 'fileRecovery.begin',
                      generation,
                      observationId: facts.observationId,
                      scope,
                      title,
                      inputRevision: facts.inputRevision,
                    });
                    const live = current.current === original && revision.current === input;
                    cancel();
                    if (
                      live &&
                      value &&
                      'version' in value &&
                      value.version === 1 &&
                      'fork' in value &&
                      value.fork?.phase === 'succeeded'
                    )
                      await onSelect(value.fork.request.newSessionId);
                  }, true)
                }
              >
                执行恢复
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert">
          {error === 'file_recovery_code_changed' || error === 'file_recovery_code_unconfirmed'
            ? '当前文件不再是已确认的代码恢复结果。保留原代码成功记录，会话分支尚未提交。'
            : error}
        </p>
      )}
      {submissions.map((intent) => {
        const id = intent.code?.request.commandId ?? intent.fork!.request.commandId,
          foreign = intent.storeId !== selection?.storeId;
        return (
          <div key={id}>
            <p>
              保存的恢复 {id} · {intent.scope} · 代码 {intent.code?.phase ?? '无'} · 会话{' '}
              {intent.fork?.phase ?? '无'}
              {foreign ? ' · 外部 Store 只读' : ''}
            </p>
            <button
              type="button"
              disabled={pending || foreign}
              onClick={() =>
                void action(async () => {
                  const readId = crypto.randomUUID();
                  read.current = readId;
                  await bridge.request({
                    method: 'fileRecovery.lookup',
                    generation,
                    intentId: id,
                    readId,
                  });
                }, true)
              }
            >
              查询原恢复
            </button>
            {intent.scope === 'both' &&
              intent.code?.phase === 'succeeded' &&
              intent.fork?.phase === 'not_started' && (
                <button
                  type="button"
                  disabled={
                    pending || readonly || foreign || selection?.session.id !== intent.sessionId
                  }
                  onClick={() =>
                    void action(async () => {
                      const original = current.current,
                        input = revision.current;
                      const value = await bridge.request({
                        method: 'fileRecovery.continue',
                        generation,
                        intentId: id,
                      });
                      if (
                        current.current === original &&
                        revision.current === input &&
                        value &&
                        'version' in value &&
                        value.version === 1 &&
                        'fork' in value &&
                        value.fork?.phase === 'succeeded'
                      )
                        await onSelect(value.fork.request.newSessionId);
                    }, true)
                  }
                >
                  明确继续原会话分支
                </button>
              )}
            {intent.fork?.phase === 'succeeded' && (
              <button
                type="button"
                disabled={foreign || pending}
                onClick={() => void onSelect(intent.fork!.request.newSessionId)}
              >
                打开恢复会话
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
