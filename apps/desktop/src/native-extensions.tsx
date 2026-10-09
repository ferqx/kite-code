import type { ExtensionCatalogue, Json, PublicView } from '@kite-ai/client';
import { ActionInputForm, PublicViewCard } from '@kite-ai/ui';
import { useEffect, useRef, useState } from 'react';
import type { NativeExtensionScope, NativeExtensionSubmission } from './extensions-bridge';
import type { NativeBridge, NativeCallerMetadata } from './native-bridge';
import { readNativeExtensionBody } from './native-extension-read';

export function NativeExtensions({
  bridge,
  scope,
  submissions = [],
  canRead = false,
  canInvoke = false,
}: {
  bridge: NativeBridge;
  scope: NativeExtensionScope;
  submissions?: readonly NativeCallerMetadata[];
  canRead?: boolean;
  canInvoke?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<ExtensionCatalogue[]>([]);
  const [views, setViews] = useState<PublicView[]>([]);
  const [observation, setObservation] = useState<number>();
  const [viewsObservation, setViewsObservation] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<NativeExtensionSubmission>();
  const [intent, setIntent] = useState<{ commandId: string; input: Json }>();
  const identity = JSON.stringify(scope),
    current = useRef(identity),
    epoch = useRef(0),
    locked = useRef(false);
  current.current = identity;
  const matches = (version: number) => current.current === identity && epoch.current === version;
  useEffect(
    () => () => {
      if (current.current === identity) current.current = '';
      epoch.current++;
      void bridge
        .request({ method: 'extensions.release', generation: scope.generation })
        .catch(() => {});
    },
    [bridge, scope.generation, identity],
  );
  async function load() {
    if (!canRead) {
      setError('此连接不支持扩展读取。');
      return;
    }
    const version = ++epoch.current;
    setBusy(true);
    setObservation(undefined);
    setViewsObservation(undefined);
    setError('');
    try {
      const body = await readNativeExtensionBody<ExtensionCatalogue>(
        bridge,
        {
          method: 'extensions.open',
          generation: scope.generation,
          readId: crypto.randomUUID(),
          viewSelection: scope.viewSelection,
          historyEpoch: scope.historyEpoch,
        },
        scope,
        'catalogue',
        () => matches(version),
      );
      if (matches(version)) {
        setCatalogue(body.value);
        setObservation(body.head.observationId);
      }
    } catch (cause) {
      if (matches(version)) setError(cause instanceof Error ? cause.message : '扩展读取失败');
    } finally {
      if (matches(version)) setBusy(false);
    }
  }
  async function query(extensionId: string, queryId: string, input: unknown) {
    if (!observation || locked.current) return;
    locked.current = true;
    const version = ++epoch.current,
      original = observation;
    setBusy(true);
    setObservation(undefined);
    setViewsObservation(undefined);
    setError('');
    try {
      const body = await readNativeExtensionBody<PublicView>(
        bridge,
        {
          method: 'extensions.query',
          generation: scope.generation,
          readId: crypto.randomUUID(),
          observationId: original,
          extensionId,
          queryId,
          input: input as Json,
        },
        scope,
        'views',
        () => matches(version),
      );
      if (matches(version)) {
        setViews(body.value);
        setViewsObservation(body.head.observationId);
        setObservation(body.head.observationId);
      }
    } catch (cause) {
      if (matches(version)) setError(cause instanceof Error ? cause.message : '扩展查询失败');
    } finally {
      locked.current = false;
      if (matches(version)) setBusy(false);
    }
  }
  function matchesResult(value: NativeExtensionSubmission, commandId: string) {
    return (
      value.metadata.request.commandId === commandId &&
      value.metadata.request.kind === 'extension.invoke' &&
      value.metadata.scope.storeId === scope.storeId &&
      value.metadata.scope.sessionId === scope.sessionId &&
      value.metadata.scope.workspaceId === scope.workspaceId
    );
  }
  async function invoke(
    extensionId: string,
    actionId: string,
    definitionVersion: string,
    input: Json,
    viewIndex?: number,
    actionIndex?: number,
  ) {
    const authority = viewIndex === undefined ? observation : viewsObservation;
    if (!canInvoke || !authority || locked.current || intent) return;
    locked.current = true;
    const version = epoch.current,
      commandId = crypto.randomUUID();
    setIntent({ commandId, input });
    setBusy(true);
    setError('');
    try {
      const value = await bridge.request({
        method: 'extensions.invoke',
        generation: scope.generation,
        observationId: authority,
        commandId,
        extensionId,
        actionId,
        definitionVersion,
        input,
        ...(viewIndex !== undefined ? { viewIndex, actionIndex } : {}),
      });
      if (
        matches(version) &&
        value &&
        'metadata' in value &&
        value.kind === 'extensions.command' &&
        matchesResult(value, commandId)
      )
        setResult(value);
    } catch {
      if (matches(version)) setError('动作结果未知，请查询原命令。');
    } finally {
      locked.current = false;
      if (matches(version)) setBusy(false);
    }
  }
  async function lookup(commandId: string) {
    if (locked.current) return;
    locked.current = true;
    const version = epoch.current;
    setBusy(true);
    try {
      const value = await bridge.request({
        method: 'extensions.lookup',
        generation: scope.generation,
        commandId,
      });
      if (
        matches(version) &&
        value &&
        'metadata' in value &&
        value.kind === 'extensions.command' &&
        matchesResult(value, commandId)
      )
        setResult(value);
    } catch {
      if (matches(version)) setError('原命令暂时无法核实。');
    } finally {
      locked.current = false;
      if (matches(version)) setBusy(false);
    }
  }
  const records = submissions.filter(
    (value) =>
      value.request.kind === 'extension.invoke' &&
      value.scope.storeId === scope.storeId &&
      value.scope.sessionId === scope.sessionId &&
      value.scope.workspaceId === scope.workspaceId,
  );
  return (
    <details
      aria-label="扩展能力"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        if (next) void load();
        else {
          epoch.current++;
          setObservation(undefined);
          setViewsObservation(undefined);
          void bridge
            .request({ method: 'extensions.release', generation: scope.generation })
            .catch(() => {});
        }
      }}
    >
      <summary>扩展能力</summary>
      {open && (
        <>
          <button type="button" disabled={busy} onClick={() => void load()}>
            刷新扩展目录
          </button>
          {busy && <p role="status">正在核对扩展能力，上次完整结果仅供阅读。</p>}
          {error && <p role="alert">{error}</p>}
          {!busy && !error && catalogue.length === 0 && <p>此会话没有可用扩展能力。</p>}
          {catalogue.map((extension) => (
            <section key={`${extension.extensionId}/${extension.version}`}>
              <h3>
                {extension.extensionId} · {extension.version}
              </h3>
              {!extension.actions.length && !extension.queries.length && (
                <p>此扩展没有公开动作或查询。</p>
              )}
              {extension.actions.map((action) => (
                <div key={action.id}>
                  <h4>{action.description || action.id}</h4>
                  <ActionInputForm
                    schema={action.inputSchema}
                    disabled={!canInvoke || busy || !observation || !!intent}
                    submitLabel="执行动作"
                    onSubmit={(input) =>
                      invoke(extension.extensionId, action.id, action.version, input as Json)
                    }
                  />
                </div>
              ))}
              {extension.queries.map((item) => (
                <div key={item.id}>
                  <h4>{item.description || item.id}</h4>
                  <ActionInputForm
                    schema={item.inputSchema}
                    disabled={busy || !observation}
                    submitLabel="读取结果"
                    onSubmit={(input) => query(extension.extensionId, item.id, input)}
                  />
                </div>
              ))}
            </section>
          ))}
          {views.map((view, viewIndex) => (
            <PublicViewCard
              key={`${view.extensionId}/${viewIndex}`}
              view={view}
              onAction={
                canInvoke && !busy && viewsObservation && !intent
                  ? (action) =>
                      void invoke(
                        view.extensionId,
                        action.actionId,
                        action.definitionVersion,
                        action.input,
                        viewIndex,
                        view.actions.indexOf(action),
                      )
                  : undefined
              }
            />
          ))}
          {intent && (
            <>
              <p>
                原命令 {intent.commandId}：{result?.outcome ?? 'unknown'}
                {result?.outcome === 'accepted' ? '（已受理，执行尚未完成）' : ''}
              </p>
              <pre>{JSON.stringify(intent.input, null, 2)}</pre>
              <button type="button" disabled={busy} onClick={() => void lookup(intent.commandId)}>
                查询原命令
              </button>
              {result &&
                ['succeeded', 'failed', 'cancelled', 'rejected'].includes(result.outcome) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setIntent(undefined);
                      setResult(undefined);
                    }}
                  >
                    新动作
                  </button>
                )}
            </>
          )}
          {!intent && result && (
            <p role="status">
              原命令 {result.metadata.request.commandId}：{result.outcome}
            </p>
          )}
          {records
            .filter((record) => record.request.commandId !== intent?.commandId)
            .map((record) => (
              <p key={record.request.commandId}>
                {record.request.commandId} · {record.phase}{' '}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void lookup(record.request.commandId)}
                >
                  查询原命令
                </button>
              </p>
            ))}
        </>
      )}
    </details>
  );
}
