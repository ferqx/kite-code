import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeCallerMetadata, NativeState } from './native-bridge';
import { useNativeDiagnostics } from './native-diagnostics';
import { NativeExecutionResult } from './native-result';
/** Public metadata and finite original body reads; no profile or execution authority. */
export function NativeCallerView({
  bridge,
  state,
  onRefresh,
}: {
  bridge: NativeBridge;
  state: NativeState;
  onRefresh: () => Promise<unknown>;
}) {
  const diagnostics = useNativeDiagnostics();
  const [busy, setBusy] = useState(false);
  const [showRecords, setShowRecords] = useState(false);
  const [body, setBody] = useState(''),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  const active = useRef<string | undefined>(undefined),
    epoch = useRef(0),
    lastScope = useRef('');
  const scopeKey = `${state.generation}:${state.selection?.session.id ?? ''}`;
  const viewedBody = useMemo(() => {
    if (!body || diagnostics) return undefined;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }, [body, diagnostics]);
  useEffect(() => {
    if (lastScope.current === scopeKey) return;
    lastScope.current = scopeKey;
    epoch.current++;
    const id = active.current;
    active.current = undefined;
    if (id)
      void bridge
        .request({ method: 'caller.close', generation: state.generation, readId: id })
        .catch(() => {});
    setReading(false);
    setBody('');
    setShowRecords(false);
  }, [bridge, state.generation, scopeKey]);
  async function read(row: NativeCallerMetadata) {
    const previous = active.current;
    if (previous)
      await bridge.request({
        method: 'caller.close',
        generation: state.generation,
        readId: previous,
      });
    const nonce = ++epoch.current,
      readId = crypto.randomUUID();
    active.current = readId;
    setReading(true);
    setError('');
    let text = '',
      offset = 0;
    try {
      for (;;) {
        const page = await bridge.request({
          method: 'caller.body',
          generation: state.generation,
          commandId: row.request.commandId,
          readId,
          offset,
          limit: 65536,
        });
        if (nonce !== epoch.current) return;
        if (
          !page ||
          !('readId' in page) ||
          !('kind' in page) ||
          page.kind !== 'caller.body' ||
          page.readId !== readId ||
          page.commandId !== row.request.commandId ||
          page.offset !== offset ||
          page.bodyDigest !== row.bodyDigest
        )
          throw Error('caller_body_identity');
        text += page.data;
        if (page.eof) {
          const bytes = new TextEncoder().encode(text);
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            (b) => b.toString(16).padStart(2, '0'),
          ).join('');
          if (digest !== row.bodyDigest || bytes.length !== page.bodyBytes)
            throw Error('caller_body_hash');
          if (nonce === epoch.current) setBody(text);
          return;
        }
        if (page.nextOffset <= offset) throw Error('caller_body_gap');
        offset = page.nextOffset;
      }
    } catch (e) {
      if (nonce === epoch.current)
        setError(e instanceof Error ? e.message : 'caller_body_unavailable');
    } finally {
      await bridge
        .request({ method: 'caller.close', generation: state.generation, readId })
        .catch(() => {});
      if (nonce === epoch.current) {
        setReading(false);
        active.current = undefined;
      }
    }
  }
  async function action(
    method: 'caller.lookup' | 'caller.clear' | 'cancelInput',
    row: NativeCallerMetadata,
  ) {
    setError('');
    setBusy(true);
    try {
      await bridge.request({
        method,
        generation: state.generation,
        commandId: row.request.commandId,
      });
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'caller_unavailable');
    } finally {
      setBusy(false);
    }
  }
  const hasActiveExecution = (row: NativeCallerMetadata) =>
    state.selection?.runs.some(
      (run) => run.isActive && run.originCommandId === row.request.commandId,
    ) ||
    state.selection?.executions.some(
      (execution) =>
        row.target.kind === 'execution' &&
        execution.id === row.target.id &&
        ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(execution.status),
    );
  const rows =
    state.callerSubmissions?.filter(
      (row) => diagnostics || showRecords || row.phase !== 'applied' || hasActiveExecution(row),
    ) ?? [];
  if (!diagnostics && !state.callerSubmissions?.length && !state.callerUnavailable && !error)
    return null;
  return (
    <section aria-label="持久原申请">
      {(diagnostics || rows.length > 0) && <h2>{diagnostics ? '持久原申请' : '提交状态'}</h2>}
      {!diagnostics && state.callerSubmissions?.length && (
        <button
          type="button"
          onClick={() => {
            setShowRecords((value) => !value);
            setBody('');
            epoch.current++;
            const id = active.current;
            active.current = undefined;
            setReading(false);
            if (id)
              void bridge.request({
                method: 'caller.close',
                generation: state.generation,
                readId: id,
              });
          }}
        >
          {showRecords ? '关闭提交记录' : '查看提交记录'}
        </button>
      )}
      {state.callerUnavailable && <p>caller_storage_unavailable · 首次提交不可用</p>}
      {rows.map((row) => (
        <div key={row.request.commandId}>
          <p>
            {diagnostics ? (
              <>
                原申请 {row.request.commandId} · {row.request.kind} · {row.scope.sessionId} ·{' '}
                {row.phase}
              </>
            ) : (
              <>原申请：{row.phase}</>
            )}
          </p>
          {(diagnostics || ['submitting', 'unknown', 'accepted'].includes(row.phase)) && (
            <button type="button" disabled={busy} onClick={() => void action('caller.lookup', row)}>
              只查原申请{diagnostics ? ` · ${row.request.commandId}` : ''}
            </button>
          )}
          <button type="button" onClick={() => void read(row)}>
            {diagnostics ? `原完整请求 · ${row.request.commandId}` : '查看原提交内容'}
          </button>
          {(diagnostics ||
            ['submitting', 'unknown', 'accepted'].includes(row.phase) ||
            hasActiveExecution(row)) &&
            ['run.start', 'input.steer', 'input.follow_up'].includes(row.request.kind) &&
            !(
              state.selection?.storeId === row.scope.storeId &&
              state.selection.session.id === row.scope.sessionId &&
              state.selection.interactions.some(
                (card) => card.kind === 'question' && card.state === 'pending',
              )
            ) && (
              <button type="button" disabled={busy} onClick={() => void action('cancelInput', row)}>
                取消原申请{diagnostics ? ` · ${row.request.commandId}` : ''}
              </button>
            )}
          {(diagnostics || showRecords) && ['applied', 'rejected'].includes(row.phase) && (
            <button type="button" disabled={busy} onClick={() => void action('caller.clear', row)}>
              {diagnostics ? `清除已核实申请 · ${row.request.commandId}` : '清理已核实提交记录'}
            </button>
          )}
        </div>
      ))}
      {reading && (
        <button
          type="button"
          onClick={() => {
            epoch.current++;
            const id = active.current;
            active.current = undefined;
            setReading(false);
            if (id)
              void bridge.request({
                method: 'caller.close',
                generation: state.generation,
                readId: id,
              });
          }}
        >
          停止本次读取
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {body && (
        <section aria-label="原申请全文">
          {diagnostics ? <pre>{body}</pre> : <NativeExecutionResult result={viewedBody} />}
        </section>
      )}
    </section>
  );
}
