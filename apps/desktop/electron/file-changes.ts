import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentClient,
  ClientError,
  type Execution,
  type Message,
  type Workspace,
} from '@kite-ai/client';
import type {
  DesktopEditor,
  NativeFileChange,
  NativeFileChangeDetail,
  NativeFileChangePage,
  NativeFileChangeScope,
  NativeFileTargetPage,
} from '../src/file-changes-bridge';
import { editorFileTarget } from './editor';

type Root = { path: string; device: string; inode: string; rootUri: string };
type Entry = {
  public: NativeFileChange;
  scope: NativeFileChangeScope;
  message: Message;
  executionId: string;
  resultRevision: string;
  root?: Root;
};
type Lease = { readId: string; scope: NativeFileChangeScope; abort: AbortController };
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function baseline(value: unknown) {
  const item = object(value);
  return item &&
    typeof item.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(item.hash) &&
    Number.isSafeInteger(item.size) &&
    Number(item.size) >= 0 &&
    typeof item.device === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(item.device) &&
    typeof item.inode === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(item.inode)
    ? item
    : undefined;
}
function resultFacts(execution: Execution) {
  const result = object(execution.result);
  let content: Record<string, unknown> | undefined;
  try {
    content = object(JSON.parse(String(result?.content)));
  } catch {
    /* Old unreadable result. */
  }
  const path =
    execution.definitionVersion === '2' &&
    baseline(content?.baseline) &&
    typeof content?.path === 'string'
      ? content.path
      : undefined;
  const change = object(object(result?.details)?.fileChange);
  const after = baseline(change?.after),
    expected = baseline(content?.baseline);
  const preview =
    path &&
    change?.version === 1 &&
    change.path === path &&
    ['line_diff', 'file_content'].includes(String(change.format)) &&
    typeof change.text === 'string' &&
    Buffer.byteLength(change.text) <= 65536 &&
    Buffer.from(change.text).toString('utf8') === change.text &&
    typeof change.truncated === 'boolean' &&
    (change.before === null || baseline(change.before)) &&
    after &&
    expected &&
    ['hash', 'size', 'device', 'inode'].every((key) => after[key] === expected[key])
      ? { text: change.text as string, truncated: change.truncated as boolean }
      : undefined;
  return { path, preview };
}

/** Read exact saved Tool receipts. An observed path is never renderer filesystem authority. */
export class NativeFileChanges {
  private readonly entries = new Map<string, Entry>();
  private readonly reads = new Map<string, Lease>();
  private readonly byMessage = new Map<string, string>();
  private readonly client: AgentClient;
  private readonly current: () => NativeFileChangeScope | undefined;
  private readonly message: (id: string) => Message | undefined;
  private readonly workspace: (id: string) => Workspace | undefined;
  private readonly protectedRoots: readonly string[];
  constructor(
    client: AgentClient,
    current: () => NativeFileChangeScope | undefined,
    message: (id: string) => Message | undefined,
    workspace: (id: string) => Workspace | undefined,
    protectedRoots: readonly string[] = [],
  ) {
    this.client = client;
    this.current = current;
    this.message = message;
    this.workspace = workspace;
    this.protectedRoots = protectedRoots;
  }
  private check(lease: Lease) {
    const now = this.current();
    if (
      this.reads.get(lease.readId) !== lease ||
      lease.abort.signal.aborted ||
      !now ||
      Object.keys(lease.scope).some(
        (key) =>
          now[key as keyof NativeFileChangeScope] !==
          lease.scope[key as keyof NativeFileChangeScope],
      )
    )
      throw new ClientError('native_selection_changed');
  }
  private begin(readId: string, scope: NativeFileChangeScope) {
    if (this.reads.has(readId) || this.reads.size >= 64)
      throw new ClientError('file_change_read_busy');
    const lease = { readId, scope: { ...scope }, abort: new AbortController() };
    this.reads.set(readId, lease);
    return lease;
  }
  private async receipt(lease: Lease, message: Message, includeRead = false) {
    this.check(lease);
    if (
      message.role !== 'tool' ||
      message.status !== 'complete' ||
      message.sessionId !== lease.scope.sessionId ||
      message.sourceIds?.length !== 1 ||
      message.contentFormat === 'unsupported'
    )
      return undefined;
    const origin = message.originMessage;
    if (origin && origin.storeId !== lease.scope.storeId)
      throw new ClientError('file_change_identity_mismatch');
    const runId = origin?.runId ?? message.runId;
    if (!runId) return undefined;
    const execution = await this.client.getExecution(message.sourceIds[0]!, {
      signal: lease.abort.signal,
    });
    this.check(lease);
    if (
      execution.id !== message.sourceIds[0] ||
      execution.originStoreId !== lease.scope.storeId ||
      execution.sessionId !== (origin?.sessionId ?? message.sessionId) ||
      execution.runId !== runId
    )
      throw new ClientError('file_change_identity_mismatch');
    const result = object(execution.result);
    return execution.kind === 'tool' &&
      (['files.write', 'files.edit'].includes(execution.definitionId) ||
        (includeRead && execution.definitionId === 'files.read')) &&
      execution.status === 'succeeded' &&
      result?.outcome === 'succeeded' &&
      result.content === message.content
      ? execution
      : undefined;
  }
  private async root(lease: Lease): Promise<Root | undefined> {
    const observed = this.workspace(lease.scope.workspaceId);
    if (!observed) return undefined;
    let actual: Workspace;
    try {
      actual = await this.client.getWorkspace(observed.id, { signal: lease.abort.signal });
    } catch {
      this.check(lease);
      return undefined;
    }
    this.check(lease);
    if (actual.id !== observed.id || actual.rootUri !== observed.rootUri)
      throw new ClientError('workspace_directory_unavailable');
    try {
      const path = fileURLToPath(actual.rootUri);
      if (realpathSync.native(path) !== path) return undefined;
      const stat = statSync(path, { bigint: true });
      return stat.isDirectory()
        ? { path, device: String(stat.dev), inode: String(stat.ino), rootUri: actual.rootUri }
        : undefined;
    } catch {
      return undefined;
    }
  }
  private async sameWorkspace(lease: Lease, message: Message) {
    if (!message.originMessage) return true;
    try {
      const source = await this.client.getView(message.originMessage.sessionId, {
        signal: lease.abort.signal,
      });
      this.check(lease);
      return (
        source.storeId === lease.scope.storeId &&
        source.session.id === message.originMessage.sessionId &&
        source.session.workspaceId === lease.scope.workspaceId
      );
    } catch {
      this.check(lease);
      return false;
    }
  }
  async list(
    input: {
      readId: string;
      messageIds: string[];
      viewSelection: number;
      historyEpoch: number;
    },
    includeRead = false,
  ): Promise<NativeFileChangePage | NativeFileTargetPage> {
    if (
      input.messageIds.length < 1 ||
      input.messageIds.length > 32 ||
      new Set(input.messageIds).size !== input.messageIds.length
    )
      throw new ClientError('invalid_native_request');
    const scope = this.current();
    if (
      !scope ||
      scope.viewSelection !== input.viewSelection ||
      scope.historyEpoch !== input.historyEpoch
    )
      throw new ClientError('native_selection_changed');
    const lease = this.begin(input.readId, scope);
    try {
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const root = await this.root(lease);
      const entries: NativeFileChange[] = [];
      for (const id of input.messageIds) {
        const message = this.message(id);
        if (!message) throw new ClientError('file_change_message_unavailable');
        const execution = await this.receipt(lease, message, includeRead);
        if (!execution) continue;
        const facts = resultFacts(execution),
          changeId = randomUUID();
        const entry: Entry = {
          public: {
            changeId,
            messageId: message.id,
            ...(facts.path ? { path: facts.path } : {}),
            preview: facts.preview ? 'available' : 'unavailable',
            // Reading Fork provenance does not bind another physical Workspace.
            openable: !!root && !!facts.path && (await this.sameWorkspace(lease, message)),
            operation: execution.definitionId.slice('files.'.length) as 'read' | 'write' | 'edit',
          },
          scope: lease.scope,
          message: structuredClone(message),
          executionId: execution.id,
          resultRevision: execution.resultRevision,
          root,
        };
        const previous = this.byMessage.get(message.id);
        const original = previous ? this.entries.get(previous) : undefined;
        // Two retained UI consumers may read the same immutable receipt. Keep its observation stable.
        if (
          original &&
          original.resultRevision === entry.resultRevision &&
          original.executionId === entry.executionId &&
          original.message.content === entry.message.content &&
          original.message.runId === entry.message.runId &&
          JSON.stringify(original.message.originMessage) ===
            JSON.stringify(entry.message.originMessage) &&
          original.public.path === entry.public.path &&
          original.public.preview === entry.public.preview &&
          original.public.openable === entry.public.openable &&
          original.public.operation === entry.public.operation &&
          JSON.stringify(original.scope) === JSON.stringify(entry.scope) &&
          JSON.stringify(original.root) === JSON.stringify(entry.root)
        ) {
          entries.push({ ...original.public });
        } else {
          if (previous) this.entries.delete(previous);
          this.byMessage.set(message.id, changeId);
          this.entries.set(changeId, entry);
          entries.push({ ...entry.public });
        }
      }
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      return {
        kind: includeRead ? 'fileTargets.page' : 'fileChanges.page',
        readId: input.readId,
        scope: { ...scope },
        entries,
      };
    } finally {
      this.close(input.readId);
    }
  }
  private entry(changeId: string) {
    const entry = this.entries.get(changeId),
      now = this.current();
    if (
      !entry ||
      !now ||
      Object.keys(entry.scope).some(
        (key) =>
          now[key as keyof NativeFileChangeScope] !==
          entry.scope[key as keyof NativeFileChangeScope],
      )
    )
      throw new ClientError('file_change_observation_unavailable');
    return entry;
  }
  private async original(lease: Lease, entry: Entry) {
    await this.client.verifyConnection({ signal: lease.abort.signal });
    this.check(lease);
    const execution = await this.receipt(lease, entry.message, true);
    if (
      !execution ||
      execution.id !== entry.executionId ||
      execution.resultRevision !== entry.resultRevision
    )
      throw new ClientError('file_change_observation_unavailable');
    return resultFacts(execution);
  }
  async detail(changeId: string, readId: string): Promise<NativeFileChangeDetail> {
    const entry = this.entry(changeId),
      lease = this.begin(readId, entry.scope);
    try {
      const facts = await this.original(lease, entry);
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      return { kind: 'fileChanges.detail', changeId, ...facts.preview };
    } finally {
      this.close(readId);
    }
  }
  async open(
    changeId: string,
    editor: DesktopEditor,
    perform: (editor: DesktopEditor, path: string) => Promise<void>,
  ) {
    if (!['vscode', 'zed', 'textedit'].includes(editor))
      throw new ClientError('invalid_native_request');
    const entry = this.entry(changeId),
      lease = this.begin(randomUUID(), entry.scope);
    try {
      if (!entry.public.openable || !entry.root || !entry.public.path)
        throw new ClientError('file_editor_target_unavailable');
      const facts = await this.original(lease, entry);
      const root = await this.root(lease);
      if (
        !root ||
        root.path !== entry.root.path ||
        root.device !== entry.root.device ||
        root.inode !== entry.root.inode ||
        root.rootUri !== entry.root.rootUri ||
        facts.path !== entry.public.path
      )
        throw new ClientError('workspace_directory_unavailable');
      if (!(await this.sameWorkspace(lease, entry.message)))
        throw new ClientError('file_editor_target_unavailable');
      let target: string;
      try {
        target = editorFileTarget(root.path, facts.path!);
      } catch {
        throw new ClientError('file_editor_target_unavailable');
      }
      if (
        this.protectedRoots.some((root) => {
          const path = relative(root, target);
          return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
        })
      )
        throw new ClientError('file_editor_target_unavailable');
      this.check(lease);
      await perform(editor, target);
    } finally {
      this.close(lease.readId);
    }
  }
  /** A clicked Markdown path names a current project file; it is not a file-change receipt. */
  async openMessageFile(
    input: {
      messageId: string;
      path: string;
      editor: DesktopEditor;
      viewSelection: number;
      historyEpoch: number;
    },
    perform: (editor: DesktopEditor, path: string) => Promise<void>,
  ) {
    const scope = this.current();
    if (
      !scope ||
      scope.viewSelection !== input.viewSelection ||
      scope.historyEpoch !== input.historyEpoch
    )
      throw new ClientError('native_selection_changed');
    const message = this.message(input.messageId);
    if (
      !message ||
      message.sessionId !== scope.sessionId ||
      message.contentFormat === 'unsupported' ||
      (message.originMessage && message.originMessage.storeId !== scope.storeId)
    )
      throw new ClientError('file_change_message_unavailable');
    if (!['vscode', 'zed', 'textedit'].includes(input.editor))
      throw new ClientError('invalid_native_request');
    const lease = this.begin(randomUUID(), scope);
    try {
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const root = await this.root(lease);
      if (!root || !(await this.sameWorkspace(lease, message)))
        throw new ClientError('file_editor_target_unavailable');
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      let target: string;
      try {
        const current = statSync(root.path, { bigint: true });
        if (String(current.dev) !== root.device || String(current.ino) !== root.inode)
          throw new ClientError('workspace_directory_unavailable');
        target = editorFileTarget(root.path, input.path);
      } catch (cause) {
        if (cause instanceof ClientError) throw cause;
        throw new ClientError('file_editor_target_unavailable');
      }
      if (
        this.protectedRoots.some((root) => {
          const path = relative(root, target);
          return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
        })
      )
        throw new ClientError('file_editor_target_unavailable');
      this.check(lease);
      await perform(input.editor, target);
    } finally {
      this.close(lease.readId);
    }
  }
  close(readId: string) {
    const lease = this.reads.get(readId);
    if (lease) {
      this.reads.delete(readId);
      lease.abort.abort();
    }
  }
  release() {
    for (const id of this.reads.keys()) this.close(id);
    this.entries.clear();
    this.byMessage.clear();
  }
}
