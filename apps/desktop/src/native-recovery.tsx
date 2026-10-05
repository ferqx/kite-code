import { useEffect, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeRecoveryFacts,
  NativeRecoverySubmission,
  NativeSelection,
} from './native-bridge';

export function NativeRecoveryView({
  bridge,
  generation,
  selection,
  submissions = [],
  onRefresh,
}: {
  bridge: NativeBridge;
  generation: number;
  selection: NativeSelection;
  submissions?: readonly NativeRecoverySubmission[];
  onRefresh: () => Promise<unknown>;
}) {
  const [kind, setKind] = useState<'run' | 'report' | 'interrupt'>('run'),
    [target, setTarget] = useState(''),
    [facts, setFacts] = useState<NativeRecoveryFacts>(),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const current = useRef(0),
    read = useRef<string | undefined>(undefined);
  const sessionId = selection.session.id;
  useEffect(() => {
    void sessionId;
    current.current++;
    setFacts(undefined);
    setConfirm(false);
    setBusy(false);
    if (read.current) {
      void bridge
        .request({ method: 'recovery.close', generation, readId: read.current })
        .catch(() => {});
      read.current = undefined;
    }
    return () => {
      current.current++;
      if (read.current)
        void bridge
          .request({ method: 'recovery.close', generation, readId: read.current })
          .catch(() => {});
    };
  }, [bridge, generation, sessionId]);
  const perform = async (action: () => Promise<unknown>) => {
    const observed = current.current;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (observed === current.current)
        setError((cause as { code?: string }).code ?? 'recovery_unavailable');
    } finally {
      if (observed === current.current) {
        setBusy(false);
        try {
          await onRefresh();
        } catch (cause) {
          if (observed === current.current)
            setError((cause as { code?: string }).code ?? 'recovery_unavailable');
        }
      }
    }
  };
  const root =
    selection.session.parentSessionId === null &&
    selection.session.rootSessionId === selection.session.id;
  return (
    <section aria-label="Explicit recovery">
      <h2>Explicit recovery</h2>
      <p>
        Original Session {selection.session.id}. Recovery resumes the explicit original ID. Applied
        records do not prove Run completion.
      </p>
      <label>
        Recovery operation
        <select
          aria-label="Recovery operation"
          value={kind}
          disabled={busy}
          onChange={(event) => {
            setKind(event.target.value as typeof kind);
            setFacts(undefined);
            setConfirm(false);
          }}
        >
          <option value="run">Original Run</option>
          <option value="report">Original report Command</option>
          <option value="interrupt">Interrupt orphan group</option>
        </select>
      </label>
      {kind !== 'interrupt' && (
        <label>
          Original recovery ID
          <input
            aria-label="Original recovery ID"
            value={target}
            disabled={busy}
            onChange={(event) => {
              setTarget(event.target.value);
              setFacts(undefined);
            }}
          />
        </label>
      )}
      <button
        type="button"
        disabled={!root || busy || (kind !== 'interrupt' && !/^[A-Za-z0-9_-]{1,128}$/.test(target))}
        onClick={() =>
          void perform(async () => {
            const id = crypto.randomUUID(),
              observed = current.current;
            read.current = id;
            try {
              const value = await bridge.request({
                method: 'recovery.prepare',
                generation,
                kind,
                ...(kind === 'interrupt' ? {} : { targetId: target }),
                readId: id,
              });
              if (observed === current.current && read.current === id) {
                setFacts(value as NativeRecoveryFacts);
                setConfirm(false);
              }
            } finally {
              if (read.current === id) read.current = undefined;
            }
          })
        }
      >
        Prepare original recovery
      </button>
      {facts && (
        <div>
          <p>
            Verified original {facts.kind} · {facts.sessionId} ·{' '}
            {facts.targetId ?? 'orphan execution group'}
          </p>
          {facts.kind === 'interrupt' && (
            <label>
              <input
                type="checkbox"
                aria-label="Confirm orphan interruption"
                checked={confirm}
                disabled={busy}
                onChange={(event) => setConfirm(event.target.checked)}
              />
              Explicitly interrupt this Session's orphan execution group; unknown Tool or Model
              effects remain unknown.
            </label>
          )}
          <button
            type="button"
            disabled={busy || (facts.kind === 'interrupt' && !confirm)}
            onClick={() =>
              void perform(() =>
                bridge.request({
                  method: 'recovery.submit',
                  generation,
                  observationId: facts.observationId,
                  confirm,
                }),
              )
            }
          >
            Submit original recovery once
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={!busy || !read.current}
        onClick={() => {
          current.current++;
          setFacts(undefined);
          setBusy(false);
          if (read.current)
            void bridge
              .request({ method: 'recovery.close', generation, readId: read.current })
              .catch(() => {});
        }}
      >
        Stop recovery read
      </button>
      {error && <p role="alert">{error}</p>}
      {submissions.map((saved) => (
        <div key={saved.commandId}>
          <p>
            Recovery {saved.kind} · {saved.phase} · original Session {saved.sessionId} · Command{' '}
            {saved.commandId}
          </p>
          {saved.run && (
            <p>
              Original result Run {saved.run.id} · {saved.run.status}
            </p>
          )}
          {saved.command?.kind === 'session.recover' && saved.command.receipt && (
            <pre>{JSON.stringify(saved.command.receipt, null, 2)}</pre>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const id = crypto.randomUUID();
                read.current = id;
                try {
                  await bridge.request({
                    method: 'recovery.lookup',
                    generation,
                    commandId: saved.commandId,
                    readId: id,
                  });
                } finally {
                  if (read.current === id) read.current = undefined;
                }
              })
            }
          >
            Lookup original recovery
          </button>
        </div>
      ))}
    </section>
  );
}
