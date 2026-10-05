import {
  ClientError,
  type FileCheckpointArtifact,
  type FileCheckpointBaseline,
  type FileCheckpointDetail,
  type FileCheckpointPage,
  type FileRestoreStatus,
} from '@kite-ai/client';
import { useEffect, useMemo, useState } from 'react';

type ListPage = FileCheckpointPage;
type Detail = FileCheckpointDetail;
type RestoreStatus = FileRestoreStatus;
type Point = ListPage['payload']['items'][number]['checkpoint'];
type Boundary = Point['boundary'];
interface Observation {
  storeId: string;
  sessionId: string;
  workspaceId: string;
}
export interface FileCheckpointPort {
  readonly serverInfo?: {
    readonly storeId?: string | null;
    readonly dataAvailability: 'available' | 'unavailable';
    readonly capabilities: readonly string[];
  };
  listFileCheckpoints?(
    sessionId: string,
    input?: { afterKey?: string; limit?: number; signal?: AbortSignal },
  ): Promise<ListPage>;
  getFileCheckpoint?(
    sessionId: string,
    pointId: string,
    options?: { signal?: AbortSignal },
  ): Promise<Detail>;
  getFileRestoreStatus?(
    sessionId: string,
    pointId: string,
    restoreId: string,
    options?: { signal?: AbortSignal },
  ): Promise<RestoreStatus>;
}
export interface FileCheckpointScope extends Observation {
  contextSelectionId: string;
  revision: string;
}
interface State {
  items?: ListPage['payload']['items'];
  nextAfterKey?: string | null;
  point?: ListPage['payload']['items'][number];
  detail?: Detail['payload'];
  status?: RestoreStatus['payload'] & { requestedRestoreId: string };
  loading: Partial<Record<'list' | 'detail' | 'status', boolean>>;
  error: Partial<Record<'list' | 'detail' | 'status', string>>;
}
const initial = (): State => ({ loading: {}, error: {} });
const keyPattern = /^checkpoint\/[a-f0-9]{64}\/point$/;
const pointPattern = /^[a-f0-9]{64}$/;
const restorePattern = /^[A-Za-z0-9_-]{1,128}$/;
const maximumMetadataBytes = 8 * 1024 * 1024;
function conflict(): never {
  throw new ClientError('file_checkpoint_scope_conflict');
}
function budget(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumMetadataBytes)
    throw new ClientError('file_checkpoint_metadata_budget_exceeded');
}
/** Observation only. No Command, Action, media or file authority is accepted by this port. */
export class FileCheckpointReader {
  state: State = initial();
  private readonly requests = new Map<'list' | 'detail' | 'status', AbortController>();
  private readonly versions = new Map<'list' | 'detail' | 'status', number>();
  private disposed = false;
  private readonly client: FileCheckpointPort;
  readonly scope: FileCheckpointScope;
  private readonly publish: (state: State) => void;
  constructor(
    client: FileCheckpointPort,
    scope: FileCheckpointScope,
    publish: (state: State) => void,
  ) {
    this.client = client;
    this.scope = Object.freeze({ ...scope });
    this.publish = publish;
  }
  private update(state: State) {
    if (!this.disposed) {
      this.state = state;
      this.publish(state);
    }
  }
  private stopKind(kind: 'list' | 'detail' | 'status') {
    this.versions.set(kind, (this.versions.get(kind) ?? 0) + 1);
    this.requests.get(kind)?.abort();
    this.requests.delete(kind);
  }
  stop() {
    for (const kind of ['list', 'detail', 'status'] as const) this.stopKind(kind);
    this.update({ ...this.state, loading: {} });
  }
  dispose() {
    this.disposed = true;
    this.stop();
  }
  private identity(value: Observation) {
    if (
      this.client.serverInfo?.storeId !== this.scope.storeId ||
      this.client.serverInfo.dataAvailability !== 'available' ||
      value.storeId !== this.scope.storeId ||
      value.sessionId !== this.scope.sessionId ||
      value.workspaceId !== this.scope.workspaceId
    )
      conflict();
  }
  private pointIdentity(point: Point) {
    if (!pointPattern.test(point.id)) conflict();
  }
  private async read(
    kind: 'list' | 'detail' | 'status',
    task: (signal: AbortSignal) => Promise<(state: State) => State>,
  ) {
    if (this.disposed || this.state.loading[kind]) return;
    const request = new AbortController();
    this.requests.set(kind, request);
    const version = (this.versions.get(kind) ?? 0) + 1;
    this.versions.set(kind, version);
    const live = () =>
      !this.disposed && !request.signal.aborted && this.versions.get(kind) === version;
    this.update({
      ...this.state,
      loading: { ...this.state.loading, [kind]: true },
      error: { ...this.state.error, [kind]: undefined },
    });
    try {
      this.identity(this.scope);
      if (!this.client.serverInfo?.capabilities.includes('file_checkpoints'))
        throw new ClientError('file_checkpoints_unavailable');
      const apply = await task(request.signal);
      if (!live()) return;
      this.identity(this.scope);
      const next = apply(this.state);
      budget(next);
      this.update({ ...next, loading: { ...next.loading, [kind]: false } });
    } catch (error) {
      if (live())
        this.update({
          ...this.state,
          loading: { ...this.state.loading, [kind]: false },
          error: {
            ...this.state.error,
            [kind]: error instanceof ClientError ? error.code : 'file_checkpoint_read_unavailable',
          },
        });
    } finally {
      if (live()) this.requests.delete(kind);
    }
  }
  async list(refresh: boolean) {
    const prior = this.state;
    if (!refresh && !prior.nextAfterKey) return;
    const afterKey = refresh ? undefined : prior.nextAfterKey!;
    await this.read('list', async (signal) => {
      if (!this.client.listFileCheckpoints) throw new ClientError('file_checkpoints_unavailable');
      const page = await this.client.listFileCheckpoints(this.scope.sessionId, {
        ...(afterKey ? { afterKey } : {}),
        limit: 200,
        signal,
      });
      this.identity(page);
      budget(page);
      const data = page.payload;
      if (!Array.isArray(data.items) || data.items.length > 200) conflict();
      let previous = afterKey ?? '';
      for (const item of data.items) {
        this.pointIdentity(item.checkpoint);
        const key = `checkpoint/${item.checkpoint.id}/point`;
        if (key <= previous) conflict();
        previous = key;
      }
      if (
        data.nextAfterKey !== null &&
        (!keyPattern.test(data.nextAfterKey) ||
          data.items.length === 0 ||
          data.nextAfterKey !== previous)
      )
        conflict();
      return (state) => {
        const items = refresh ? data.items : [...(prior.items ?? []), ...data.items];
        budget(items);
        if (
          state.point &&
          !items.some(
            (item) =>
              item.checkpoint.id === state.point!.checkpoint.id &&
              item.revision === state.point!.revision,
          )
        ) {
          this.stopKind('detail');
          this.stopKind('status');
          return {
            ...state,
            items,
            nextAfterKey: data.nextAfterKey,
            point: undefined,
            detail: undefined,
            status: undefined,
            loading: { list: true },
            error: {},
          };
        }
        return { ...state, items, nextAfterKey: data.nextAfterKey };
      };
    });
  }
  async select(item: ListPage['payload']['items'][number]) {
    const target = structuredClone(item);
    this.pointIdentity(target.checkpoint);
    const same =
      this.state.point?.checkpoint.id === target.checkpoint.id &&
      this.state.point.revision === target.revision;
    this.stopKind('detail');
    this.stopKind('status');
    this.update({
      ...this.state,
      point: target,
      detail: same ? this.state.detail : undefined,
      status: same ? this.state.status : undefined,
      loading: { list: this.state.loading.list },
      error: { list: this.state.error.list },
    });
    await this.read('detail', async (signal) => {
      if (!this.client.getFileCheckpoint) throw new ClientError('file_checkpoints_unavailable');
      const detail = await this.client.getFileCheckpoint(
        this.scope.sessionId,
        target.checkpoint.id,
        { signal },
      );
      this.identity(detail);
      this.pointIdentity(detail.payload.checkpoint);
      budget(detail);
      if (
        detail.payload.checkpoint.id !== target.checkpoint.id ||
        detail.payload.checkpoint.workspace.device !== target.checkpoint.workspace.device ||
        detail.payload.checkpoint.workspace.inode !== target.checkpoint.workspace.inode ||
        Object.keys(target.checkpoint.boundary).some(
          (key) =>
            detail.payload.checkpoint.boundary[key as keyof Boundary] !==
            target.checkpoint.boundary[key as keyof Boundary],
        )
      )
        conflict();
      return (state) => ({ ...state, detail: detail.payload });
    });
  }
  async restoreStatus(restoreId: string) {
    const item = this.state.point;
    if (!item || !restorePattern.test(restoreId)) return;
    this.stopKind('status');
    if (this.state.status?.requestedRestoreId !== restoreId)
      this.update({ ...this.state, status: undefined });
    await this.read('status', async (signal) => {
      if (!this.client.getFileRestoreStatus) throw new ClientError('file_checkpoints_unavailable');
      const result = await this.client.getFileRestoreStatus(
        this.scope.sessionId,
        item.checkpoint.id,
        restoreId,
        { signal },
      );
      this.identity(result);
      budget(result);
      const data = result.payload;
      if (
        (data.journal &&
          (data.journal.id !== restoreId || data.journal.checkpointId !== item.checkpoint.id)) ||
        (data.execution &&
          data.execution.id !==
            (data.journal && 'executionId' in data.journal ? data.journal.executionId : undefined))
      )
        conflict();
      return (state) => ({ ...state, status: { ...data, requestedRestoreId: restoreId } });
    });
  }
  editRestoreTarget() {
    this.stopKind('status');
    this.update({
      ...this.state,
      status: undefined,
      loading: { ...this.state.loading, status: false },
      error: { ...this.state.error, status: undefined },
    });
  }
}

function BaselineMetadata({
  label,
  value,
}: {
  label: string;
  value: FileCheckpointBaseline | null;
}) {
  return (
    <p>
      {label}:{' '}
      {value
        ? `hash ${value.hash} · bytes ${value.size} · device ${value.device} · inode ${value.inode}`
        : 'not recorded'}
    </p>
  );
}
function PreimageMetadata({ value }: { value: FileCheckpointArtifact | null }) {
  return (
    <p>
      Preimage metadata:{' '}
      {value
        ? `${value.id} · ${value.mediaType} · bytes ${value.size} · Execution ${value.scope.id}`
        : 'not recorded'}
    </p>
  );
}

export function FileCheckpoints({
  client,
  scope,
  window: browser,
  suspended = false,
}: {
  client: FileCheckpointPort;
  scope: FileCheckpointScope;
  window: Window;
  suspended?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [state, setState] = useState<State>(initial),
    [restoreId, setRestoreId] = useState('');
  const reader = useMemo(
    () =>
      new FileCheckpointReader(
        client,
        {
          storeId: scope.storeId,
          sessionId: scope.sessionId,
          workspaceId: scope.workspaceId,
          contextSelectionId: scope.contextSelectionId,
          revision: scope.revision,
        },
        setState,
      ),
    [
      client,
      scope.storeId,
      scope.sessionId,
      scope.workspaceId,
      scope.contextSelectionId,
      scope.revision,
    ],
  );
  useEffect(() => {
    setOpen(false);
    setRestoreId('');
    setState(reader.state);
    const hide = () => {
      if (browser.document.visibilityState === 'hidden') {
        reader.stop();
        setOpen(false);
      }
    };
    browser.document.addEventListener('visibilitychange', hide);
    return () => {
      reader.dispose();
      browser.document.removeEventListener('visibilitychange', hide);
    };
  }, [reader, browser]);
  useEffect(() => {
    if (suspended) {
      reader.stop();
      setOpen(false);
    }
  }, [reader, suspended]);
  const readable =
    !suspended &&
    browser.document.visibilityState !== 'hidden' &&
    client.serverInfo?.storeId === scope.storeId &&
    client.serverInfo.dataAvailability === 'available' &&
    client.serverInfo.capabilities.includes('file_checkpoints') &&
    !!client.listFileCheckpoints &&
    !!client.getFileCheckpoint &&
    !!client.getFileRestoreStatus;
  return (
    <section aria-label="File checkpoints">
      <button
        type="button"
        disabled={!readable}
        onClick={() => {
          setOpen(true);
          void reader.list(true);
        }}
      >
        File checkpoints
      </button>
      {!readable && <p>File checkpoints unavailable</p>}
      {open && (
        <div>
          <p>
            Current observation: Store {scope.storeId} · Workspace {scope.workspaceId} · Session{' '}
            {scope.sessionId}. Read-only metadata; pages do not form a frozen directory snapshot.
          </p>
          <button
            type="button"
            onClick={() => {
              reader.stop();
              setOpen(false);
            }}
          >
            Close File checkpoints
          </button>
          <button
            type="button"
            disabled={!!state.loading.list}
            onClick={() => void reader.list(true)}
          >
            Refresh File checkpoints
          </button>
          {state.error.list && (
            <p role="status">
              {state.items ? 'Stale checkpoint metadata' : 'Checkpoint directory unavailable'}:{' '}
              {state.error.list}
            </p>
          )}
          {state.loading.list && <p>Reading checkpoint metadata</p>}
          {state.items?.length === 0 && !state.error.list && <p>No recorded checkpoints</p>}
          <ul>
            {state.items?.map((item) => (
              <li key={item.checkpoint.id}>
                <button
                  type="button"
                  onClick={() => {
                    setRestoreId('');
                    void reader.select(item);
                  }}
                >
                  Point {item.checkpoint.id} · revision {item.revision}
                </button>
                <span>
                  {' '}
                  Original Store {item.checkpoint.boundary.storeId} · Run{' '}
                  {item.checkpoint.boundary.runId} · boundary {item.checkpoint.boundary.messageSeq}{' '}
                  · trigger {item.checkpoint.boundary.triggerSeq}
                </span>
              </li>
            ))}
          </ul>
          {state.nextAfterKey && (
            <button
              type="button"
              disabled={!!state.loading.list || !!state.error.list}
              onClick={() => void reader.list(false)}
            >
              Next checkpoint page
            </button>
          )}
          {state.point && (
            <section aria-label="Checkpoint detail">
              <h3>Original point {state.point.checkpoint.id}</h3>
              <p>
                Original Store {state.point.checkpoint.boundary.storeId} · Workspace{' '}
                {state.point.checkpoint.boundary.workspaceId} · Session{' '}
                {state.point.checkpoint.boundary.sessionId} · Run{' '}
                {state.point.checkpoint.boundary.runId} · selection{' '}
                {state.point.checkpoint.boundary.contextSelectionId}
              </p>
              <p>
                Boundary message{' '}
                {state.point.checkpoint.boundary.messageId ?? 'before first message'} · sequence{' '}
                {state.point.checkpoint.boundary.messageSeq}; trigger{' '}
                {state.point.checkpoint.boundary.triggerMessageId} · sequence{' '}
                {state.point.checkpoint.boundary.triggerSeq}
              </p>
              {state.loading.detail && <p>Reading point metadata</p>}
              {state.error.detail && (
                <p role="status">
                  {state.detail ? 'Stale point metadata' : 'Point metadata unavailable'}:{' '}
                  {state.error.detail}
                </p>
              )}
              {state.detail?.files.map((file) => (
                <div key={file.path}>
                  <p>
                    {file.path} · preview {file.status} · revision {file.recordRevision}
                    {file.reason
                      ? ` · ${file.reason === 'file_path_protected' ? 'protected · ' : ''}${file.reason}`
                      : ''}
                  </p>
                  <BaselineMetadata label="Original baseline" value={file.original} />
                  <BaselineMetadata label="Expected baseline" value={file.expected} />
                  <PreimageMetadata value={file.preimage} />
                </div>
              ))}
              <p>Preview describes a read-only observation; it does not authorize restoration.</p>
              <label>
                Original restore ID{' '}
                <input
                  value={restoreId}
                  maxLength={128}
                  onInput={(event) => {
                    reader.editRestoreTarget();
                    setRestoreId(event.currentTarget.value);
                  }}
                />
              </label>
              <button
                type="button"
                disabled={!restorePattern.test(restoreId) || !!state.loading.status}
                onClick={() => void reader.restoreStatus(restoreId)}
              >
                Read original restore status
              </button>
              {state.error.status && (
                <p role="status">
                  {state.status ? 'Stale restore metadata' : 'Restore metadata unavailable'}:{' '}
                  {state.error.status}
                </p>
              )}
              {state.status && (
                <section aria-label="Original restore status">
                  <p>Requested original restore ID {state.status.requestedRestoreId}</p>
                  <p>Journal phase: {state.status.journal?.phase ?? 'not recorded'}</p>
                  <p>
                    Actual carrier:{' '}
                    {state.status.execution
                      ? `${state.status.execution.id} · ${state.status.execution.status} · revision ${state.status.execution.resultRevision}`
                      : 'unavailable'}
                  </p>
                  <p>Journal phase does not establish carrier success.</p>
                  {state.status.journal && 'reason' in state.status.journal && (
                    <div>
                      <p>
                        {state.status.journal.reason} · head revision{' '}
                        {state.status.journal.headRevision}
                      </p>
                      {state.status.journal.fileRevisions.map((file) => (
                        <p key={file.path}>
                          {file.path} · revision {file.revision}
                        </p>
                      ))}
                    </div>
                  )}
                  {state.status.journal && 'rootWorkSeq' in state.status.journal && (
                    <p>Original root Work sequence {state.status.journal.rootWorkSeq}</p>
                  )}
                  {state.status.journal &&
                    'files' in state.status.journal &&
                    state.status.journal.files.map((file) => (
                      <div key={file.path}>
                        <p>
                          {file.path} · {file.operation} · {file.state}
                          {file.error ? ` · ${file.error}` : ''}
                        </p>
                        <BaselineMetadata label="Original baseline" value={file.original} />
                        <BaselineMetadata label="Expected baseline" value={file.expected} />
                        <PreimageMetadata value={file.preimage} />
                        {'confirmedPost' in file &&
                          (file.confirmedPost ? (
                            <BaselineMetadata
                              label="Confirmed post baseline"
                              value={file.confirmedPost.baseline}
                            />
                          ) : (
                            <p>Confirmed post: not recorded</p>
                          ))}
                      </div>
                    ))}
                </section>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
