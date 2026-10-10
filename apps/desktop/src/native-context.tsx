import { ContextPanel, ContextSubmissionNotice } from '@kite-ai/ui';
import { useEffect, useRef, useState } from 'react';
import type { ContextSubmission } from './controller';
import type {
  NativeBridge,
  NativeCompressionSubmission,
  NativeContextFacts,
  NativeSelection,
} from './native-bridge';

/** This view forwards the shared Include scope unchanged; it never chooses an active Run. */
export function NativeContextView({
  bridge,
  generation,
  selection,
  submissions = [],
  compressionSubmissions = [],
  onInspectModel,
  onRefresh,
}: {
  bridge: NativeBridge;
  generation: number;
  selection: NativeSelection;
  submissions?: readonly ContextSubmission[];
  compressionSubmissions?: readonly NativeCompressionSubmission[];
  onInspectModel?: (executionId: string) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const failure = (cause: unknown) => {
    const value =
      (cause as { code?: string; message?: string }).code ??
      (cause as { message?: string }).message;
    return value && /^[a-z][a-z0-9_]{0,80}$/.test(value) ? value : 'context_unavailable';
  };
  const [facts, setFacts] = useState<NativeContextFacts>(),
    [focus, setFocus] = useState(''),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  const identity = `${generation}/${selection.storeId}/${selection.session.id}/${selection.viewSelection}`;
  const current = useRef(identity),
    mutation = useRef(false),
    readId = useRef<string | undefined>(undefined),
    readSequence = useRef(0);
  current.current = identity;
  // biome-ignore lint/correctness/useExhaustiveDependencies: The identity invalidates this view even when the component is not remounted.
  useEffect(() => {
    setFacts(undefined);
    setFocus('');
    setError('');
    setReading(false);
    readSequence.current++;
    return () => {
      readSequence.current++;
      if (readId.current)
        void bridge
          .request({ method: 'context.close', generation, readId: readId.current })
          .catch(() => {});
      readId.current = undefined;
    };
  }, [bridge, generation, identity]);
  useEffect(() => {
    if (selection.permissionUnavailable && !selection.viewLoading) setFacts(undefined);
  }, [selection.permissionUnavailable, selection.viewLoading]);
  async function read(next = false) {
    if (reading || !selection.canReadContext) return;
    const original = identity,
      sequence = ++readSequence.current,
      id = crypto.randomUUID();
    readId.current = id;
    setReading(true);
    setFacts(undefined);
    setError('');
    try {
      const value = await bridge.request({
        method: next ? 'context.next' : 'context.read',
        generation,
        sessionId: selection.session.id,
        readId: id,
      });
      if (original !== current.current || sequence !== readSequence.current) return;
      if (
        !value ||
        !('observationId' in value) ||
        !('page' in value) ||
        !('selection' in value.page) ||
        value.page.selection.sessionId !== selection.session.id
      )
        throw Error('context_scope_mismatch');
      setFacts({ observationId: value.observationId, page: value.page });
    } catch (cause) {
      if (original === current.current && sequence === readSequence.current)
        setError(failure(cause));
    } finally {
      if (original === current.current && sequence === readSequence.current) setReading(false);
    }
  }
  async function mutate(action: () => Promise<unknown>) {
    if (mutation.current) return;
    mutation.current = true;
    const original = identity;
    try {
      await action();
    } catch (cause) {
      if (original === current.current) setError(failure(cause));
    } finally {
      mutation.current = false;
      if (original === current.current) setFacts(undefined);
      await onRefresh();
    }
  }
  const unresolved = submissions.some((value) =>
    ['saved', 'submitting', 'unknown', 'queued'].includes(value.phase),
  );
  const writable = !unresolved && !selection.permissionUnavailable;
  const compressionPending = compressionSubmissions.some((value) =>
    ['saved', 'submitting', 'unknown', 'accepted'].includes(value.phase),
  );
  const active = selection.runs.filter((run) => run.isActive);
  const busy =
    selection.runs.some((run) => run.isActive) ||
    selection.executions.some((execution) =>
      ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(execution.status),
    );
  return (
    <section aria-label="当前所选上下文">
      {selection.canReadContext ? (
        <button type="button" disabled={reading} onClick={() => void read()}>
          读取当前所选上下文
        </button>
      ) : (
        <p>上下文能力不可用；当前只读。</p>
      )}
      {reading && <p role="status">正在读取原会话上下文…</p>}
      {error && <p role="alert">上下文不可写：{error}。原选择与命令仍按原身份保存。</p>}
      {facts && (
        <section aria-label="手动上下文压缩">
          {facts.page.compression ? (
            <div>
              <p>
                活动压缩记录 {facts.page.compression.id} · 原存储{' '}
                {facts.page.compression.originStoreId} · 原会话{' '}
                {facts.page.compression.originSessionId}
              </p>
              <p>
                覆盖至消息序号 {facts.page.compression.coveredThroughSeq} · 发布序号{' '}
                {facts.page.compression.publishedSeq} · 上一记录{' '}
                {facts.page.compression.previousCompressionId ?? '无'}
              </p>
              <p>
                实际模型执行 {facts.page.compression.modelExecutionId} · 原轮次{' '}
                {facts.page.compression.runId} ·{' '}
                {facts.page.compression.trigger === 'manual' ? '人工请求' : '自动请求'}
              </p>
              {onInspectModel &&
                facts.page.compression.originSessionId === selection.session.id && (
                  <button
                    type="button"
                    onClick={() => onInspectModel(facts.page.compression!.modelExecutionId)}
                  >
                    查看此压缩的原模型输入
                  </button>
                )}
            </div>
          ) : (
            <p>无活动压缩点；重置无需请求模型。</p>
          )}
          <p>压缩只影响后续输入，摘要和原历史仍保留。命令受理不表示压缩轮次已经完成。</p>
          <label>
            完整压缩重点
            <textarea
              aria-label="完整压缩重点"
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
            />
          </label>
          {writable && selection.session.parentSessionId === null && (
            <>
              <button
                type="button"
                disabled={busy || compressionPending}
                onClick={() =>
                  void mutate(() =>
                    bridge.request({
                      method: 'context.compress',
                      generation,
                      observationId: facts.observationId,
                      focus,
                    }),
                  )
                }
              >
                明确请求手动压缩
              </button>
              <button
                type="button"
                disabled={busy || compressionPending}
                onClick={() =>
                  void mutate(() =>
                    bridge.request({
                      method: 'context.resetCompression',
                      generation,
                      observationId: facts.observationId,
                    }),
                  )
                }
              >
                预检并重置压缩点
              </button>
            </>
          )}
          {(busy || selection.session.parentSessionId !== null) && (
            <p>当前工作仍活动或属于子会话，压缩管理只读。</p>
          )}
        </section>
      )}
      {compressionSubmissions.map((value) => (
        <div key={value.intent.commandId}>
          <p>
            原压缩命令 {value.intent.commandId} · 原会话 {value.sessionId} ·{' '}
            {value.kind === 'compress' ? '手动压缩' : '压缩重置'}：{value.phase} · 完整重点{' '}
            {value.intent.focusBytes} 字节
          </p>
          {value.run && (
            <p>
              压缩原轮次：{value.run.status}
              {value.run.reason ? `（${value.run.reason}）` : ''}；这是实际执行事实。
            </p>
          )}
          {value.error && (
            <p role="alert">原操作未确认或失败：{value.error}。原历史与压缩点由服务保留。</p>
          )}
          <button
            type="button"
            onClick={() =>
              void mutate(() =>
                bridge.request({
                  method: 'lookupCompression',
                  generation,
                  commandId: value.intent.commandId,
                }),
              )
            }
          >
            查询原压缩命令与执行
          </button>
        </div>
      ))}
      {facts && (
        <ContextPanel
          context={facts.page}
          history={selection.executions}
          storeId={selection.storeId}
          activeRun={active.length === 1 ? active[0] : undefined}
          busy={busy || unresolved}
          onNextPage={() => read(true)}
          onRewind={
            writable
              ? (boundary) =>
                  mutate(() =>
                    bridge.request({
                      method: 'context.rewind',
                      generation,
                      observationId: facts.observationId,
                      boundary,
                    }),
                  )
              : undefined
          }
          onInclude={
            writable
              ? (execution, scope) =>
                  mutate(() =>
                    bridge.request({
                      method: 'context.include',
                      generation,
                      observationId: facts.observationId,
                      executionId: execution.id,
                      resultRevision: execution.resultRevision!,
                      scope,
                    }),
                  )
              : undefined
          }
        />
      )}
      {submissions.map((submission) => (
        <div key={submission.intent.commandId}>
          <p>
            原会话 {submission.sessionId} · 原存储 {submission.intent.expectedStoreId} · 原上下文{' '}
            {submission.intent.expectedContextSelectionId}
          </p>
          <ContextSubmissionNotice
            submission={{
              kind: submission.kind,
              commandId: submission.intent.commandId,
              phase: submission.phase,
              error: submission.error,
            }}
          />
          {['unknown', 'queued'].includes(submission.phase) && (
            <button
              type="button"
              onClick={() =>
                void mutate(() =>
                  bridge.request({
                    method: 'lookupContext',
                    generation,
                    commandId: submission.intent.commandId,
                  }),
                )
              }
            >
              查询原上下文命令
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
