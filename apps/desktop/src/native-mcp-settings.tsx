import type { McpAuthStatus, McpToolsPage } from '@kite-ai/client';
import { useEffect, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeMcpFacts,
  NativeMcpOperation,
  NativeMcpRemovalPreview,
  NativeMcpRequest,
  NativeMcpResult,
  NativeMcpSubmission,
  NativeSelection,
} from './native-bridge';

const safeError = (cause: unknown) =>
  /^[a-z][a-z0-9_]{0,80}$/.test((cause as Error)?.message ?? '')
    ? (cause as Error).message
    : 'mcp_unavailable';
export function NativeMcpSettings({
  bridge,
  generation,
  selection,
  submissions,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  submissions: readonly NativeMcpSubmission[];
}) {
  const [facts, setFacts] = useState<NativeMcpFacts>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [local, setLocal] = useState<NativeMcpSubmission[]>([]);
  const [removal, setRemoval] = useState<NativeMcpRemovalPreview>();
  const [previewReading, setPreviewReading] = useState(false);
  const [review, setReview] = useState<NativeMcpOperation>(),
    [name, setName] = useState(''),
    [scope, setScope] = useState<'user' | 'workspace'>('user'),
    [transport, setTransport] = useState<'http' | 'stdio'>('http'),
    [address, setAddress] = useState(''),
    [expiry, setExpiry] = useState('');
  const [auth, setAuth] = useState<Record<string, McpAuthStatus>>({}),
    [tools, setTools] = useState<McpToolsPage>(),
    [descriptor, setDescriptor] = useState('');
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const current = useRef(identity);
  current.current = identity;
  const sequence = useRef(0),
    flight = useRef(false),
    reader = useRef<string | undefined>(undefined);
  const originals = new Map(local.map((value) => [value.commandId, value]));
  for (const value of submissions) originals.set(value.commandId, value);
  const records = [...originals.values()];
  const pending = records.some(
    (value) =>
      value.storeId === facts?.storeId &&
      ['submitting', 'pending', 'outcome_unknown'].includes(value.phase),
  );
  const writable = !!facts?.canWrite && !pending && !busy;
  const remember = (value: NativeMcpSubmission) =>
    setLocal((values) => [...values.filter((item) => item.commandId !== value.commandId), value]);
  async function request(input: NativeMcpRequest): Promise<NativeMcpResult | undefined> {
    const original = identity,
      seq = ++sequence.current;
    setError('');
    try {
      const result = await bridge.request(input);
      if (current.current !== original || seq !== sequence.current) return undefined;
      if (!result || !('kind' in result) || !result.kind.startsWith('settings.mcp'))
        throw Error('mcp_unavailable');
      return result as NativeMcpResult;
    } catch (cause) {
      if (current.current === original && seq === sequence.current) setError(safeError(cause));
    }
    return undefined;
  }
  function chooseReview(operation?: NativeMcpOperation) {
    sequence.current++;
    setRemoval(undefined);
    setPreviewReading(false);
    setReview(operation);
  }
  async function removePreview(serverId: string, scope: 'user' | 'workspace') {
    if (!facts || !writable) return;
    chooseReview();
    setPreviewReading(true);
    const original = identity,
      expectedSequence = sequence.current + 1;
    const result = await request({
      method: 'settings.mcp.removePreview',
      generation,
      observationId: facts.observationId,
      serverId,
      scope,
    });
    if (current.current !== original || sequence.current !== expectedSequence) return;
    setPreviewReading(false);
    if (!result) return;
    if (
      result.kind !== 'settings.mcp.removePreview' ||
      result.observationId !== facts.observationId ||
      result.serverId !== serverId ||
      result.scope !== scope ||
      result.preview.target.serverId !== serverId ||
      result.preview.target.source.kind !== scope
    ) {
      setError('mcp_removal_preview_invalid');
      return;
    }
    setRemoval(result);
    setReview({ kind: 'remove', serverId, scope });
  }
  async function read() {
    closeDescriptor();
    setTools(undefined);
    chooseReview();
    setAuth({});
    setFacts(undefined);
    const result = await request({ method: 'settings.mcp.read', generation });
    if (result?.kind === 'settings.mcp') {
      if (
        selection &&
        (result.storeId !== selection.storeId || result.sessionId !== selection.session.id)
      ) {
        setError('mcp_scope_mismatch');
        return;
      }
      setFacts(result);
    }
  }
  function closeDescriptor() {
    const readId = reader.current;
    reader.current = undefined;
    setDescriptor('');
    if (readId)
      void bridge
        .request({ method: 'settings.mcp.descriptor.close', generation, readId })
        .catch(() => {});
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Every host selection invalidates all observation and reader responses.
  useEffect(() => {
    sequence.current++;
    setFacts(undefined);
    setTools(undefined);
    setAuth({});
    chooseReview();
    setName('');
    setAddress('');
    setExpiry('');
    setBusy(false);
    flight.current = false;
    void read();
    return () => {
      sequence.current++;
      closeDescriptor();
      void bridge.request({ method: 'settings.mcp.close', generation }).catch(() => {});
    };
  }, [identity, bridge]);
  async function submit(operation: NativeMcpOperation) {
    if (!writable || !facts || flight.current) return;
    flight.current = true;
    setBusy(true);
    const original = identity;
    try {
      const result = await request({
        method: 'settings.mcp.submit',
        generation,
        observationId: facts.observationId,
        operation,
      });
      if (result?.kind === 'settings.mcp.submission') {
        remember(result);
        chooseReview();
      }
    } finally {
      if (current.current === original) {
        flight.current = false;
        setBusy(false);
      }
    }
  }
  async function originalAction(
    method: 'settings.mcp.lookup' | 'settings.mcp.cancel',
    value: NativeMcpSubmission,
  ) {
    if (value.association !== 'current' || busy || flight.current) return;
    flight.current = true;
    setBusy(true);
    const original = identity;
    try {
      const result = await request({ method, generation, commandId: value.commandId });
      if (result?.kind === 'settings.mcp.submission') remember(result);
    } finally {
      if (current.current === original) {
        flight.current = false;
        setBusy(false);
      }
    }
  }
  async function loadTools(recordKey: string, startIndex = 0) {
    if (!facts) return;
    closeDescriptor();
    const result = await request({
      method: 'settings.mcp.tools',
      generation,
      observationId: facts.observationId,
      recordKey,
      startIndex,
    });
    if (result?.kind === 'settings.mcp.tools' && result.observationId === facts.observationId)
      setTools(result.page);
  }
  async function loadDescriptor(index: number) {
    if (!facts || !tools) return;
    const entry = tools.entries.find((value) => value.index === index);
    if (!entry) return;
    closeDescriptor();
    const original = identity,
      seq = ++sequence.current,
      readId = crypto.randomUUID();
    reader.current = readId;
    setError('');
    try {
      const opened = (await bridge.request({
        method: 'settings.mcp.descriptor',
        generation,
        observationId: facts.observationId,
        recordKey: tools.recordKey,
        index,
        readId,
      })) as NativeMcpResult;
      if (
        !opened ||
        !('kind' in opened) ||
        opened.kind !== 'settings.mcp.descriptor' ||
        opened.readId !== readId ||
        opened.bodySha256 !== entry.descriptorHash ||
        String(opened.bodyBytes) !== entry.descriptorBytes
      )
        throw Error('mcp_descriptor_invalid');
      const parts: Uint8Array[] = [];
      let offset = 0;
      while (true) {
        if (current.current !== original || seq !== sequence.current || reader.current !== readId)
          return;
        const chunk = (await bridge.request({
          method: 'settings.mcp.descriptor.read',
          generation,
          readId,
          offset,
          limit: 65536,
        })) as NativeMcpResult;
        if (
          !chunk ||
          !('kind' in chunk) ||
          chunk.kind !== 'settings.mcp.descriptor.chunk' ||
          chunk.readId !== readId ||
          chunk.offset !== offset
        )
          throw Error('mcp_descriptor_invalid');
        const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
        if (
          chunk.nextOffset !== offset + bytes.length ||
          chunk.nextOffset > opened.bodyBytes ||
          (!chunk.eof && !bytes.length)
        )
          throw Error('mcp_descriptor_invalid');
        parts.push(bytes);
        offset = chunk.nextOffset;
        if (chunk.eof) break;
      }
      if (offset !== opened.bodyBytes) throw Error('mcp_descriptor_invalid');
      const bytes = new Uint8Array(offset);
      let cursor = 0;
      for (const part of parts) {
        bytes.set(part, cursor);
        cursor += part.length;
      }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      if (digest !== opened.bodySha256) throw Error('mcp_descriptor_invalid');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      JSON.parse(text);
      if (current.current === original && seq === sequence.current && reader.current === readId)
        setDescriptor(text);
    } catch (cause) {
      if (current.current === original && seq === sequence.current && reader.current === readId)
        setError(safeError(cause));
    } finally {
      if (reader.current === readId) {
        reader.current = undefined;
        void bridge
          .request({ method: 'settings.mcp.descriptor.close', generation, readId })
          .catch(() => {});
      }
    }
  }
  return (
    <section aria-label="MCP settings">
      <h2>MCP</h2>
      <p>Connection, source decisions, authentication and Tool permissions are independent.</p>
      <button type="button" onClick={() => void read()}>
        Refresh MCP settings
      </button>
      {!selection && (
        <p>
          Select a current Session to manage MCP settings. Original submissions remain available
          below.
        </p>
      )}
      {error && (
        <p role="alert">
          {!selection && error === 'mcp_scope_unavailable'
            ? 'MCP settings need a current Session. Select a Session and reopen MCP settings.'
            : error}
        </p>
      )}
      {facts?.errors.map((value, index) => (
        <p role="alert" key={`${index}/${value}`}>
          {value}
        </p>
      ))}
      <section aria-label="Original MCP submissions">
        <h3>Original submissions</h3>
        {records.map((value) => (
          <article key={value.commandId}>
            <p>
              {value.commandId} · {value.actionId} · {value.serverId ?? value.name ?? 'source'} ·
              Store {value.storeId} · Session {value.sessionId} ·{' '}
              {value.phase === 'outcome_unknown' ? 'Outcome unknown; not completed' : value.phase} ·
              association {value.association}
            </p>
            {value.summary && <p>{value.summary}</p>}
            {value.error && <p role="alert">{value.error}</p>}
            {value.fact && <pre>{JSON.stringify(value.fact, null, 2)}</pre>}
            <button
              type="button"
              disabled={value.association !== 'current' || busy}
              onClick={() => void originalAction('settings.mcp.lookup', value)}
            >
              Check original {value.commandId}
            </button>
            {['pending', 'submitting', 'outcome_unknown'].includes(value.phase) && (
              <button
                type="button"
                disabled={value.association !== 'current' || busy}
                onClick={() => void originalAction('settings.mcp.cancel', value)}
              >
                Cancel exact original {value.commandId}
              </button>
            )}
          </article>
        ))}
      </section>
      {facts && (
        <>
          <section aria-label="MCP directory">
            <h3>Safe directory</h3>
            {facts.servers.map((server) => (
              <article key={server.id}>
                <h4>{server.id}</h4>
                <p>
                  {server.source.kind} · {server.transport} · selected {String(server.selected)} ·
                  admitted {String(server.admitted)} · available {String(server.available)} ·{' '}
                  {server.reason ?? 'no reported error'}
                </p>
                <pre>{JSON.stringify(server, null, 2)}</pre>
                {(['user', 'workspace'] as const).flatMap((scope) =>
                  [true, false].map((enabled) => (
                    <button
                      key={`${scope}/${enabled}`}
                      type="button"
                      disabled={!writable}
                      onClick={() =>
                        chooseReview({ kind: 'select', serverId: server.id, scope, enabled })
                      }
                    >
                      Select {scope} {server.id}: {enabled ? 'enable' : 'disable'}
                    </button>
                  )),
                )}
                <button
                  type="button"
                  disabled={!writable}
                  onClick={() => void submit({ kind: 'connect', serverId: server.id })}
                >
                  Connect {server.id}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const result = await request({
                      method: 'settings.mcp.auth',
                      generation,
                      observationId: facts.observationId,
                      serverId: server.id,
                    });
                    if (
                      result?.kind === 'settings.mcp.auth' &&
                      result.observationId === facts.observationId
                    )
                      setAuth((values) => ({ ...values, [server.id]: result.status }));
                  }}
                >
                  Read auth status {server.id}
                </button>
                {auth[server.id] && <pre>{JSON.stringify(auth[server.id], null, 2)}</pre>}
                {server.transport === 'http' &&
                  (['login', 'authRefresh', 'clear', 'revoke'] as const).map((kind) => (
                    <button
                      type="button"
                      key={kind}
                      disabled={!writable}
                      onClick={() => chooseReview({ kind, serverId: server.id })}
                    >
                      {
                        {
                          login: 'Login',
                          authRefresh: 'Refresh authentication',
                          clear: 'Clear authentication',
                          revoke: 'Revoke authentication',
                        }[kind]
                      }{' '}
                      {server.id}
                    </button>
                  ))}
                {records
                  .filter(
                    (value) =>
                      value.serverId === server.id &&
                      value.storeId === facts.storeId &&
                      value.sessionId === facts.sessionId &&
                      value.phase === 'completed' &&
                      value.association === 'current' &&
                      value.fact &&
                      'ready' in value.fact &&
                      value.fact.ready &&
                      value.fact.live,
                  )
                  .map((value) => (
                    <div key={value.commandId}>
                      <button
                        type="button"
                        disabled={!writable}
                        onClick={() =>
                          void submit({
                            kind: 'refresh',
                            serverId: server.id,
                            commandId: value.commandId,
                          })
                        }
                      >
                        Refresh catalogue from {value.commandId}
                      </button>
                      <button
                        type="button"
                        disabled={!writable}
                        onClick={() =>
                          chooseReview({
                            kind: 'reconnect',
                            serverId: server.id,
                            commandId: value.commandId,
                          })
                        }
                      >
                        Strong reconnect from {value.commandId}
                      </button>
                    </div>
                  ))}
              </article>
            ))}
          </section>
          <section aria-label="MCP sources">
            <h3>Configured sources</h3>
            {facts.sources.map((source) => (
              <article key={`${source.source.kind}/${source.id}`}>
                <h4>
                  {source.name} · {source.id} · {source.source.kind}
                </h4>
                <pre>{JSON.stringify(source, null, 2)}</pre>
                <button
                  type="button"
                  disabled={!writable}
                  onClick={() => void removePreview(source.id, source.source.kind)}
                >
                  Remove exact {source.source.kind} source {source.id}
                </button>
                {source.source.kind === 'workspace' && (
                  <button
                    type="button"
                    disabled={!writable}
                    onClick={() => void submit({ kind: 'approve', serverId: source.id })}
                  >
                    Request project approval {source.id}
                  </button>
                )}
                {source.transport === 'http' && (
                  <button
                    type="button"
                    disabled={
                      !writable ||
                      !Number.isSafeInteger(Number(expiry)) ||
                      Number(expiry) <= Date.now()
                    }
                    onClick={() =>
                      chooseReview({ kind: 'bind', serverId: source.id, expiresAt: Number(expiry) })
                    }
                  >
                    Review existing credential binding {source.id}
                  </button>
                )}
              </article>
            ))}
            <label>
              Binding expiry (Unix milliseconds)
              <input value={expiry} onChange={(event) => setExpiry(event.target.value)} />
            </label>
            {facts.nextAfterId && (
              <button
                type="button"
                onClick={async () => {
                  const result = await request({
                    method: 'settings.mcp.sources',
                    generation,
                    observationId: facts.observationId,
                    afterId: facts.nextAfterId!,
                  });
                  if (
                    result?.kind === 'settings.mcp.sources' &&
                    result.observationId === facts.observationId
                  )
                    setFacts((value) =>
                      value?.observationId === result.observationId
                        ? {
                            ...value,
                            sources: [...value.sources, ...result.sources],
                            nextAfterId: result.nextAfterId,
                          }
                        : value,
                    );
                }}
              >
                Next sources page
              </button>
            )}
          </section>
          <form
            aria-label="Add MCP source"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) {
                setError('mcp_name_required');
                return;
              }
              if (transport === 'http') {
                try {
                  const url = new URL(address);
                  if (
                    !['http:', 'https:'].includes(url.protocol) ||
                    url.username ||
                    url.password ||
                    url.hash
                  )
                    throw Error();
                } catch {
                  setError('mcp_http_url_invalid');
                  return;
                }
              } else if (!address.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(address)) {
                setError('mcp_absolute_command_required');
                return;
              }
              chooseReview({
                kind: 'add',
                name: name.trim(),
                scope,
                entry:
                  transport === 'http'
                    ? { type: 'http', url: address }
                    : { type: 'stdio', command: address },
              });
            }}
          >
            <h3>Add source</h3>
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              Scope
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
              >
                <option value="user">user</option>
                <option value="workspace">workspace</option>
              </select>
            </label>
            <label>
              Transport
              <select
                value={transport}
                onChange={(event) => setTransport(event.target.value as typeof transport)}
              >
                <option value="http">HTTP URL</option>
                <option value="stdio">Absolute stdio command</option>
              </select>
            </label>
            <label>
              URL or command
              <input value={address} onChange={(event) => setAddress(event.target.value)} />
            </label>
            <button type="submit" disabled={!writable}>
              Review add source
            </button>
          </form>
          <section aria-label="MCP tool snapshots">
            <h3>Immutable tool snapshots</h3>
            {facts.snapshots.map((snapshot) => (
              <article key={snapshot.recordKey}>
                <pre>{JSON.stringify(snapshot, null, 2)}</pre>
                <button
                  type="button"
                  disabled={snapshot.availability !== 'available'}
                  onClick={() => void loadTools(snapshot.recordKey)}
                >
                  Open tools {snapshot.recordKey}
                </button>
              </article>
            ))}
            {facts.nextAfterKey && (
              <button
                type="button"
                onClick={async () => {
                  const result = await request({
                    method: 'settings.mcp.snapshots',
                    generation,
                    observationId: facts.observationId,
                    afterKey: facts.nextAfterKey!,
                  });
                  if (
                    result?.kind === 'settings.mcp.snapshots' &&
                    result.observationId === facts.observationId
                  )
                    setFacts((value) =>
                      value?.observationId === result.observationId
                        ? {
                            ...value,
                            snapshots: [...value.snapshots, ...result.snapshots],
                            nextAfterKey: result.nextAfterKey,
                          }
                        : value,
                    );
                }}
              >
                Next snapshots page
              </button>
            )}
            {tools && (
              <>
                <p>
                  Tool page index {tools.startIndex} · live {String(tools.live)} ·{' '}
                  {tools.reason ?? tools.availability}
                </p>
                {tools.entries.map((entry) => (
                  <article key={entry.index}>
                    <p>
                      {entry.index} · {entry.label} · {entry.definitionId}@{entry.definitionVersion}{' '}
                      · {entry.labelComplete ? 'complete label' : 'label preview'}
                    </p>
                    <button type="button" onClick={() => void loadDescriptor(entry.index)}>
                      Read full descriptor {entry.index}
                    </button>
                  </article>
                ))}
                {tools.nextIndex !== null && (
                  <button
                    type="button"
                    onClick={() => void loadTools(tools.recordKey, tools.nextIndex!)}
                  >
                    Next tools page
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    sequence.current++;
                    closeDescriptor();
                    setTools(undefined);
                  }}
                >
                  Close tool reader
                </button>
              </>
            )}
            {descriptor && <pre data-mcp-descriptor="verified">{descriptor}</pre>}
          </section>
        </>
      )}
      {previewReading && (
        <section aria-label="MCP removal preview loading">
          <p>Reading exact source removal preview.</p>
          <button type="button" onClick={() => chooseReview()}>
            Close operation review
          </button>
        </section>
      )}
      {review && (
        <section aria-label="Confirm exact MCP operation">
          <h3>Confirm exact operation</h3>
          <pre>{JSON.stringify(review, null, 2)}</pre>
          {review.kind === 'remove' && removal && (
            <section aria-label="Exact source removal preview">
              <h4>Declaration to remove</h4>
              <pre>{JSON.stringify(removal.preview.target, null, 2)}</pre>
              <h4>Fallback after removal</h4>
              {removal.preview.fallback ? (
                <>
                  <p>
                    Removing this declaration reveals the following source. It has its own
                    selection, approval and authentication requirements.
                  </p>
                  <pre>{JSON.stringify(removal.preview.fallback, null, 2)}</pre>
                </>
              ) : (
                <p>No fallback declaration was reported.</p>
              )}
            </section>
          )}
          <p>
            Source and authentication changes do not grant remote Tool permission. Binding requests
            offer bind/revoke/cancel in the original Source Review.
          </p>
          <button
            type="button"
            disabled={
              !writable ||
              (review.kind === 'remove' &&
                (!removal ||
                  removal.observationId !== facts?.observationId ||
                  removal.serverId !== review.serverId ||
                  removal.scope !== review.scope))
            }
            onClick={() => void submit(review)}
          >
            Confirm exact MCP operation
          </button>
          <button type="button" onClick={() => chooseReview()}>
            Close operation review
          </button>
        </section>
      )}
    </section>
  );
}
