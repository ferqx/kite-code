import { ClientError, type SessionLogEntry, type SessionLogPage } from '@kite-ai/client';
import { useEffect, useMemo, useState } from 'react';

export interface RuntimeLogPort {
  readonly serverInfo?: {
    readonly storeId?: string | null;
    readonly dataAvailability: 'available' | 'unavailable';
    readonly capabilities: readonly string[];
  };
  listSessionLogs?(
    sessionId: string,
    query: {
      afterCursor: string;
      upperCursor?: string;
      limit?: number;
      signal?: AbortSignal;
    },
  ): Promise<SessionLogPage>;
}
interface State {
  entries: readonly SessionLogEntry[];
  page?: SessionLogPage;
  loading: boolean;
  error?: string;
  limited: boolean;
}
const maximumEntries = 1000;
const maximumBytes = 2 * 1024 * 1024;
function cursor(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new ClientError('session_logs_cursor_invalid');
  return BigInt(value);
}
function invalid(): never {
  throw new ClientError('session_logs_page_conflict');
}

/** Fixed observation scope, bounded metadata only. It never polls or owns Runtime work. */
class RuntimeLogReader {
  state: State = { entries: [], loading: false, limited: false };
  private request?: AbortController;
  private generation = 0;
  private bytes = 0;
  private readonly client: RuntimeLogPort;
  private readonly storeId: string;
  private readonly sessionId: string;
  private readonly publish: (state: State) => void;
  constructor(
    client: RuntimeLogPort,
    storeId: string,
    sessionId: string,
    publish: (state: State) => void,
  ) {
    this.client = client;
    this.storeId = storeId;
    this.sessionId = sessionId;
    this.publish = publish;
  }
  private update(state: State) {
    this.state = state;
    this.publish(state);
  }
  stop() {
    this.generation++;
    this.request?.abort();
    this.request = undefined;
    if (this.state.loading) this.update({ ...this.state, loading: false });
  }
  async read(refresh: boolean) {
    if (
      this.state.loading ||
      (!refresh && (!this.state.page?.nextAfterCursor || this.state.limited))
    )
      return;
    const generation = ++this.generation;
    const request = new AbortController();
    this.request = request;
    const old = this.state;
    this.update({ ...old, loading: true, error: undefined });
    try {
      if (
        !this.client.listSessionLogs ||
        this.client.serverInfo?.dataAvailability !== 'available' ||
        this.client.serverInfo?.storeId !== this.storeId ||
        !this.client.serverInfo.capabilities.includes('session_logs')
      )
        invalid();
      const after = refresh ? '0' : old.page!.nextAfterCursor!;
      const upper = refresh ? undefined : old.page!.upperCursor;
      const page = await this.client.listSessionLogs(this.sessionId, {
        afterCursor: after,
        upperCursor: upper,
        limit: 200,
        signal: request.signal,
      });
      if (request.signal.aborted || generation !== this.generation) return;
      if (
        this.client.serverInfo?.storeId !== this.storeId ||
        page.storeId !== this.storeId ||
        page.sessionId !== this.sessionId ||
        (upper !== undefined && page.upperCursor !== upper)
      )
        invalid();
      const high = cursor(page.upperCursor),
        floor = cursor(page.replayFloor);
      if (cursor(page.snapshotCursor) < high || floor > cursor(after)) invalid();
      let prior = cursor(after);
      if (!Array.isArray(page.entries) || page.entries.length > 200) invalid();
      for (const entry of page.entries) {
        const current = cursor(entry.cursor);
        if (
          entry.sessionId !== this.sessionId ||
          current <= prior ||
          current > high ||
          current < floor
        )
          invalid();
        if (entry.modelExecutionId !== null && entry.details.executionId !== entry.modelExecutionId)
          invalid();
        if (
          Object.keys(entry.details).some(
            (key) =>
              ![
                'kind',
                'definitionId',
                'definitionVersion',
                'commandId',
                'runId',
                'executionId',
                'interactionId',
                'attempt',
              ].includes(key),
          )
        )
          invalid();
        prior = current;
      }
      if (
        page.nextAfterCursor !== null &&
        (page.entries.length === 0 || cursor(page.nextAfterCursor) !== prior || prior >= high)
      )
        invalid();
      if (page.complete !== (page.nextAfterCursor === null)) invalid();
      const size = new TextEncoder().encode(JSON.stringify(page)).byteLength;
      if (size > 512 * 1024) throw new ClientError('session_logs_page_budget_exceeded');
      const entries = refresh ? page.entries : [...old.entries, ...page.entries];
      const bytes = (refresh ? 0 : this.bytes) + size;
      if (entries.length > maximumEntries || bytes > maximumBytes) {
        this.update({ ...old, loading: false, limited: true, error: 'session_logs_cache_limit' });
        return;
      }
      this.bytes = bytes;
      this.update({
        entries,
        page,
        loading: false,
        limited: entries.length >= maximumEntries || bytes >= maximumBytes,
      });
    } catch (error) {
      if (!request.signal.aborted && generation === this.generation)
        this.update({
          ...old,
          loading: false,
          error: error instanceof ClientError ? error.code : 'session_logs_read_unavailable',
        });
    } finally {
      if (generation === this.generation) this.request = undefined;
    }
  }
}

export function RuntimeLogs({
  client,
  sessionId,
  storeId,
  window: browser,
  suspended = false,
  onModel,
}: {
  client: RuntimeLogPort;
  sessionId: string;
  storeId: string;
  window: Window;
  suspended?: boolean;
  onModel: (executionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ entries: [], loading: false, limited: false });
  const reader = useMemo(
    () => new RuntimeLogReader(client, storeId, sessionId, setState),
    [client, storeId, sessionId],
  );
  const enabled =
    !!client.listSessionLogs &&
    client.serverInfo?.dataAvailability === 'available' &&
    client.serverInfo?.storeId === storeId &&
    client.serverInfo.capabilities.includes('session_logs');
  useEffect(() => {
    setOpen(false);
    setState(reader.state);
    const hide = () => {
      if (browser.document.visibilityState === 'hidden') {
        reader.stop();
        setOpen(false);
      }
    };
    browser.document.addEventListener('visibilitychange', hide);
    return () => {
      reader.stop();
      browser.document.removeEventListener('visibilitychange', hide);
    };
  }, [reader, browser]);
  useEffect(() => {
    if (suspended) {
      reader.stop();
      setOpen(false);
    }
  }, [reader, suspended]);
  const readable = enabled && !suspended && browser.document.visibilityState !== 'hidden';
  return (
    <section aria-label="Runtime logs">
      <button
        type="button"
        disabled={!readable}
        onClick={() => {
          setOpen(true);
          void reader.read(true);
        }}
      >
        Runtime logs
      </button>
      {!enabled && <p>Runtime logs unavailable</p>}
      {open && (
        <div>
          <button
            type="button"
            onClick={() => {
              reader.stop();
              setOpen(false);
            }}
          >
            Close Runtime logs
          </button>
          <button
            type="button"
            disabled={!readable || state.loading}
            onClick={() => void reader.read(true)}
          >
            Refresh Runtime logs
          </button>
          {state.loading && (
            <>
              <p role="status">Reading Runtime logs</p>
              <button type="button" onClick={() => reader.stop()}>
                Cancel log read
              </button>
            </>
          )}
          {state.error && (
            <p role="alert">
              {state.entries.length ? 'Stale · Last read logs · ' : 'Logs unavailable · '}
              {state.error}
            </p>
          )}
          {state.page && (
            <p>
              Observed through {state.page.upperCursor} · retained from {state.page.replayFloor} ·{' '}
              {state.page.complete && !state.limited
                ? 'Complete retained range'
                : 'More retained logs remain'}
            </p>
          )}
          <p>
            Metadata only. At most 1000 entries and 2 MiB are retained in this panel; this is not a
            complete backup.
          </p>
          {state.limited && (
            <p role="status">
              Local cache limit reached; refresh starts a new bounded observation.
            </p>
          )}
          {state.page && state.entries.length === 0 && <p>No retained logs</p>}
          {state.entries.map((entry) => (
            <details key={entry.cursor}>
              <summary>
                {entry.cursor} ·{' '}
                {entry.occurredAt === null
                  ? 'Time unknown'
                  : new Date(entry.occurredAt).toISOString()}{' '}
                · {entry.category} · {entry.recordedStatus ?? 'Status unknown'} · {entry.type} ·{' '}
                {entry.summary}
              </summary>
              <dl>
                {Object.entries(entry.details).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
              {entry.modelExecutionId !== null && (
                <button
                  type="button"
                  disabled={!readable || !client.serverInfo?.capabilities.includes('model_inputs')}
                  onClick={() => onModel(entry.modelExecutionId!)}
                >
                  Inspect Model {entry.modelExecutionId}
                </button>
              )}
            </details>
          ))}
          {state.page?.nextAfterCursor !== null && state.page && (
            <button
              type="button"
              disabled={!readable || state.loading || state.limited}
              onClick={() => void reader.read(false)}
            >
              Load more logs
            </button>
          )}
        </div>
      )}
    </section>
  );
}
