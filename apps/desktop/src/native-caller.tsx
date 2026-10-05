import { useEffect, useRef, useState } from 'react';
import type { NativeBridge, NativeCallerMetadata, NativeState } from './native-bridge';
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
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState(''),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  const active = useRef<string | undefined>(undefined),
    epoch = useRef(0),
    lastScope = useRef('');
  const scopeKey = `${state.generation}:${state.selection?.session.id ?? ''}`;
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
  return (
    <section aria-label="持久原申请">
      <h2>持久原申请</h2>
      {state.callerUnavailable && <p>caller_storage_unavailable · 首次提交不可用</p>}
      {state.callerSubmissions?.map((row) => (
        <div key={row.request.commandId}>
          <p>
            原申请 {row.request.commandId} · {row.request.kind} · {row.scope.sessionId} ·{' '}
            {row.phase}
          </p>
          <button type="button" disabled={busy} onClick={() => void action('caller.lookup', row)}>
            只查原申请 · {row.request.commandId}
          </button>
          <button type="button" onClick={() => void read(row)}>
            原完整请求 · {row.request.commandId}
          </button>
          {['run.start', 'input.steer', 'input.follow_up'].includes(row.request.kind) && (
            <button type="button" disabled={busy} onClick={() => void action('cancelInput', row)}>
              取消原申请 · {row.request.commandId}
            </button>
          )}
          {['applied', 'rejected'].includes(row.phase) && (
            <button type="button" disabled={busy} onClick={() => void action('caller.clear', row)}>
              清除已核实申请 · {row.request.commandId}
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
          <pre>{body}</pre>
        </section>
      )}
    </section>
  );
}
