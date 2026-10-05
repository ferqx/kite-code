import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ActionContext,
  ActionDefinition,
  Extension,
  ExtensionRecord,
  ForkSourceProjection,
  Json,
  PublicExecution,
  ReadContext,
  ToolContext,
  ToolDefinition,
} from '../../extensions';
import { canonicalJson } from '../../json';
import { AgentError } from '../../storage/types';
import { createWorkspaceFiles, type FileBaseline, type WorkspaceFiles } from '../../tools/files';
import { createFileTools, type FileMutationCapture } from '../../tools/files-tools';
import {
  fileCheckpointLocalEvents,
  forkKey,
  forkType,
  isFailedRestoreWithoutEffects,
} from './fork';
import {
  bytesDigest,
  decode,
  digest,
  effectType,
  file,
  fileKey,
  fileType,
  headType,
  intentType,
  namespace,
  point,
  pointKey,
  pointType,
  recordDefinitions,
  validate,
  write,
} from './records';
import type {
  CheckpointPreimage,
  CheckpointSource,
  FileCheckpoint,
  FileCheckpointCaptureProof,
  FileCheckpointForkEvent,
  FileCheckpointForkSnapshot,
  FileCheckpointOptions,
  FileCheckpointPreview,
  FileCheckpointReadContext,
  FileCheckpointRecord,
  FileCheckpointRecoveryBoundary,
  FileCheckpointRestoreEffect,
  FileCheckpointRestoreJournal,
} from './types';

export type {
  CheckpointSource,
  FileCheckpoint,
  FileCheckpointBoundary,
  FileCheckpointCaptureProof,
  FileCheckpointOptions,
  FileCheckpointPreview,
  FileCheckpointRecord,
  FileCheckpointRecoveryBoundary,
  FileCheckpointRestoreJournal,
  FileCheckpointSelectedLineage,
} from './types';

const equal = (a: unknown, b: unknown) => canonicalJson(a as Json) === canonicalJson(b as Json);
function fail(code: string): never {
  throw new AgentError(code);
}
function source(
  actual: PublicExecution,
): Omit<CheckpointSource, 'modelExecutionId' | 'modelInputHash'> {
  if (
    actual.kind !== 'tool' ||
    !['dispatching', 'running'].includes(actual.status) ||
    !actual.runId ||
    !['files.write', 'files.edit'].includes(actual.definitionId ?? '') ||
    actual.definitionVersion !== '2' ||
    !actual.attempt ||
    !actual.inputDigest
  )
    fail('checkpoint_source_invalid');
  return {
    executionId: actual.id,
    runId: actual.runId,
    definitionId: actual.definitionId!,
    definitionVersion: actual.definitionVersion,
    attempt: actual.attempt,
    inputDigest: actual.inputDigest,
  };
}
async function receipt(
  context: FileCheckpointReadContext,
  checkpoint: FileCheckpoint,
  original: CheckpointSource,
  path: string,
  postimage?: FileBaseline,
): Promise<void> {
  const actual = await context.getExecution(original.executionId);
  if (
    actual?.kind !== 'tool' ||
    actual.status !== 'succeeded' ||
    actual.sessionId !== checkpoint.boundary.sessionId ||
    actual.originStoreId !== checkpoint.boundary.storeId ||
    actual.runId !== original.runId ||
    original.runId !== checkpoint.boundary.runId ||
    actual.definitionId !== original.definitionId ||
    actual.definitionVersion !== original.definitionVersion ||
    actual.attempt !== original.attempt ||
    actual.inputDigest !== original.inputDigest
  )
    fail('checkpoint_source_unconfirmed');
  const result = actual.result;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    typeof result.content !== 'string'
  )
    fail('checkpoint_source_unconfirmed');
  let body: unknown;
  try {
    body = JSON.parse(result.content);
  } catch {
    fail('checkpoint_source_unconfirmed');
  }
  if (!body || typeof body !== 'object') fail('checkpoint_source_unconfirmed');
  const recorded = body as { path?: unknown; baseline?: unknown };
  if (
    typeof recorded.path !== 'string' ||
    recorded.path.split('/').filter(Boolean).join('/') !== path ||
    (postimage && !equal(recorded.baseline, postimage))
  )
    fail('checkpoint_source_unconfirmed');
}
const restoreDescriptor: Omit<ActionDefinition, 'prepare' | 'execute'> = {
  id: 'files.checkpoint.restore',
  version: '1',
  description: 'Explicit code-only restoration of original File checkpoint bytes',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['checkpointId', 'restoreId'],
    properties: {
      checkpointId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      restoreId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    },
  },
  resources: { serial: { scope: 'workspace', key: 'files.mutation' } },
};
function checkpointExtension({
  tools,
  restore,
  listPoints,
  preview,
  recoveryBoundary,
  readRestoreIntent,
}: {
  tools?: readonly ToolDefinition[];
  restore: ActionDefinition;
  listPoints(
    context: ReadContext,
    options: { afterKey?: string; limit?: number },
  ): Promise<{
    items: { checkpoint: FileCheckpoint; revision: string }[];
    nextAfterKey: string | null;
  }>;
  preview(context: ReadContext, pointId: string): Promise<FileCheckpointPreview>;
  recoveryBoundary(context: ReadContext, pointId: string): Promise<FileCheckpointRecoveryBoundary>;
  readRestoreIntent(
    context: ReadContext,
    pointId: string,
    restoreId: string,
  ): Promise<ExtensionRecord | null>;
}): Extension {
  async function queryScope(context: ReadContext) {
    if (!context.readExecutionGroupSafety) fail('checkpoint_scope_unavailable');
    const actual = await context.readExecutionGroupSafety();
    if (actual.sessionId !== context.sessionId) fail('checkpoint_scope_conflict');
  }
  return {
    id: namespace,
    version: '1',
    apiMajor: 1,
    ...(tools ? { tools } : {}),
    records: recordDefinitions,
    actions: [restore],
    queries: [
      {
        id: 'files.checkpoint.restore-status',
        version: '1',
        description: 'Read only the original restoration intent; never retry file publication',
        inputSchema: restoreDescriptor.inputSchema,
        outputSchema: { type: 'array' },
        async execute(input, context) {
          await queryScope(context);
          const value = input as { checkpointId: string; restoreId: string };
          const original = await readRestoreIntent(context, value.checkpointId, value.restoreId);
          const valueId =
            original?.value && typeof original.value === 'object' && !Array.isArray(original.value)
              ? original.value.executionId
              : null;
          const actual = typeof valueId === 'string' ? await context.getExecution(valueId) : null;
          const exact =
            actual?.kind === 'job' &&
            actual.sessionId === context.sessionId &&
            actual.runId === null &&
            actual.definitionId === `${namespace}/${restoreDescriptor.id}` &&
            actual.definitionVersion === restoreDescriptor.version &&
            actual.originStoreId === original?.originStoreId;
          return [
            {
              extensionId: namespace,
              contentType: 'builtin.files.checkpoint.restore-status',
              contentVersion: 1,
              summary: 'Original File restoration journal and actual carrier status',
              payload: {
                journal: original?.value ?? null,
                execution: exact
                  ? { id: actual.id, status: actual.status, resultRevision: actual.resultRevision }
                  : null,
              },
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
      {
        id: 'files.checkpoints',
        version: '1',
        description: 'Read actual File checkpoint boundary metadata without execution',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            afterKey: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          await queryScope(context);
          const value = await listPoints(context, input as { afterKey?: string; limit?: number });
          return [
            {
              extensionId: namespace,
              contentType: 'builtin.files.checkpoints',
              contentVersion: 1,
              summary: 'Original File checkpoint boundaries',
              payload: value as unknown as Json,
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
      {
        id: 'files.checkpoint.detail',
        version: '1',
        description:
          'Read original File checkpoint and complete-byte conflict preview without restoring files',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['pointId'],
          properties: { pointId: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
        },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          await queryScope(context);
          const pointId = (input as { pointId: string }).pointId;
          const value = await preview(context, pointId);
          return [
            {
              extensionId: namespace,
              contentType: 'builtin.files.checkpoint.preview',
              contentVersion: 1,
              summary: 'Original File checkpoint preview; no restore execution',
              payload: value as unknown as Json,
              artifactRefs: value.files.flatMap((file) => (file.preimage ? [file.preimage] : [])),
              actions: [],
            },
          ];
        },
      },
      {
        id: 'files.checkpoint.recovery-boundary',
        version: '1',
        description: 'Read the current selected Message boundary of an original File checkpoint',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['pointId'],
          properties: { pointId: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
        },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          await queryScope(context);
          const value = await recoveryBoundary(context, (input as { pointId: string }).pointId);
          return [
            {
              extensionId: namespace,
              contentType: 'builtin.files.checkpoint.recovery-boundary',
              contentVersion: 1,
              summary:
                'Current selected Message identities; original checkpoint identity is preserved',
              payload: value as unknown as Json,
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
  };
}
/** One explicitly selected Workspace, original builtin.files namespace; import opens no resource. */
export function createFileCheckpointing(options: FileCheckpointOptions) {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.workspace.id) ||
    !Array.isArray(options.protectedPaths)
  )
    fail('checkpoint_configuration_invalid');
  const selected = { ...options.workspace, root: resolve(options.workspace.root) };
  const maxBytes = options.maxBytes;
  const readBoundary = options.readBoundary;
  const files = createWorkspaceFiles({
    root: selected.root,
    protectedPaths: [...options.protectedPaths],
    ...(options.protectReads !== undefined ? { protectReads: options.protectReads } : {}),
  });
  const initial = lstatSync(selected.root, { bigint: true });
  const workspace = { device: String(initial.dev), inode: String(initial.ino) };
  interface Pending {
    context: ToolContext;
    checkpoint: FileCheckpoint;
    record: ExtensionRecord;
    candidate: CheckpointPreimage;
    path: string;
    previous: FileCheckpointRecord;
    head: ExtensionRecord;
  }
  const tokens = new WeakMap<object, Pending>();
  const token = (value: unknown, context: ToolContext) => {
    if (!value || typeof value !== 'object') return fail('checkpoint_capture_token_invalid');
    const saved = tokens.get(value);
    if (
      !saved ||
      saved.context !== context ||
      saved.candidate.source.executionId !== context.executionId
    )
      return fail('checkpoint_capture_token_invalid');
    return saved;
  };
  async function boundary(
    context: ToolContext,
    actual: PublicExecution,
  ): Promise<FileCheckpointCaptureProof> {
    if (!readBoundary) fail('checkpoint_boundary_unavailable');
    const proof = structuredClone(await readBoundary(context, structuredClone(actual)));
    const value = proof.boundary;
    context.signal.throwIfAborted();
    // Record schema performs closed field validation; IDs are information, never authority.
    const checkpoint = { id: digest(value as unknown as Json), boundary: value, workspace };
    if (
      value.storeId !== actual.originStoreId ||
      value.workspaceId !== selected.id ||
      value.sessionId !== context.sessionId ||
      value.sessionId !== actual.sessionId ||
      value.runId !== context.runId ||
      value.runId !== actual.runId ||
      BigInt(value.messageSeq) > 9223372036854775807n ||
      BigInt(value.triggerSeq) > 9223372036854775807n ||
      BigInt(value.triggerSeq) <= BigInt(value.messageSeq) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(proof.modelExecutionId) ||
      !/^[a-f0-9]{64}$/.test(proof.modelInputHash) ||
      (value.messageId === null) !== (value.messageSeq === '0')
    )
      fail('checkpoint_boundary_invalid');
    const current = await context.getRun(value.runId);
    if (!current?.isActive || current.sessionId !== context.sessionId)
      fail('checkpoint_boundary_invalid');
    // Validate before any Artifact or persistent record mutation.
    validate(pointType, checkpoint);
    return proof;
  }
  const capture: FileMutationCapture = {
    async before(input, context) {
      const actual = await context.getExecution(context.executionId);
      if (!actual) fail('checkpoint_source_invalid');
      const actualSource = source(actual);
      if (actualSource.definitionId !== `files.${input.operation}`)
        fail('checkpoint_source_invalid');
      const proof = await boundary(context, actual);
      const scope = proof.boundary;
      const original: CheckpointSource = {
        ...actualSource,
        modelExecutionId: proof.modelExecutionId,
        modelInputHash: proof.modelInputHash,
      };
      const checkpoint: FileCheckpoint = {
        id: digest(scope as unknown as Json),
        boundary: scope,
        workspace,
      };
      const key = pointKey(checkpoint.id);
      const existing = await context.records.get(key);
      if (existing) {
        if (!equal(point(existing), checkpoint)) fail('checkpoint_scope_conflict');
      } else await write(context, key, pointType, checkpoint, null);
      const headKey = `checkpoint/${checkpoint.id}/head`;
      const oldHead = await context.records.get(headKey);
      if (oldHead && decode<{ state: string }>(oldHead, headType).state !== 'idle')
        fail('checkpoint_capture_unconfirmed');
      const path = input.path.split('/').filter(Boolean).join('/');
      const recordKey = fileKey(checkpoint.id, path);
      const prior = await context.records.get(recordKey);
      const old = prior ? file(prior, checkpoint) : null;
      if (old?.pending || old?.state === 'unknown') fail('checkpoint_capture_unconfirmed');
      let bytes: Uint8Array | null = null;
      if (input.base !== null) {
        const snapshot = await files.readBytes(path, { maxBytes });
        if (!equal(snapshot.baseline, input.base)) fail('file_baseline_conflict');
        bytes = snapshot.bytes;
      } else {
        try {
          await files.readBytes(path, { maxBytes });
          fail('file_baseline_conflict');
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
      }
      context.signal.throwIfAborted();
      let artifact: CheckpointPreimage['artifact'] = null;
      if (bytes !== null) {
        if (!context.artifacts) fail('artifact_publication_unavailable');
        artifact = await context.artifacts.publish({
          key: 'files.checkpoint.preimage',
          content: bytes,
          mediaType: 'application/octet-stream',
        });
        if (
          artifact.scope?.kind !== 'execution' ||
          artifact.scope.id !== context.executionId ||
          artifact.mediaType !== 'application/octet-stream' ||
          artifact.size !== String(bytes.length) ||
          bytesDigest(bytes) !== input.base!.hash
        )
          fail('checkpoint_artifact_invalid');
      }
      const candidate: CheckpointPreimage = { source: original, baseline: input.base, artifact };
      const next: FileCheckpointRecord = {
        checkpointId: checkpoint.id,
        path,
        first: old?.first ?? null,
        last: old?.last ?? null,
        pending: candidate,
        state: 'pending',
      };
      context.signal.throwIfAborted();
      const head = await write(
        context,
        headKey,
        headType,
        { checkpointId: checkpoint.id, executionId: context.executionId, state: 'pending' },
        oldHead,
      );
      const record = await write(context, recordKey, fileType, next, prior);
      const value = {};
      tokens.set(value, { context, checkpoint, record, candidate, path, previous: next, head });
      return value;
    },
    async after(value, result, context) {
      const pending = token(value, context);
      const actual = await context.getExecution(context.executionId);
      const {
        modelExecutionId: _model,
        modelInputHash: _hash,
        ...capturedSource
      } = pending.candidate.source;
      if (!actual || !equal(source(actual), capturedSource)) fail('checkpoint_source_invalid');
      const bytes = await files.readBytes(pending.path, { maxBytes });
      if (!equal(bytes.baseline, result.baseline)) fail('checkpoint_postimage_conflict');
      context.signal.throwIfAborted();
      const next: FileCheckpointRecord = {
        ...pending.previous,
        first: pending.previous.first ?? pending.candidate,
        last: { source: pending.candidate.source, baseline: bytes.baseline },
        pending: null,
        state: 'captured',
      };
      await write(context, pending.record.key, fileType, next, pending.record);
      await write(
        context,
        pending.head.key,
        headType,
        { checkpointId: pending.checkpoint.id, executionId: context.executionId, state: 'idle' },
        pending.head,
      );
      tokens.delete(value as object);
    },
    async failed(value, error, context) {
      const pending = token(value, context);
      const unknown = (error as { code?: string }).code === 'file_publish_outcome_unknown';
      // If capture.after failed after publication, the wrapper reports unknown but this pending
      // journal remains ineligible even if this best-effort update cannot commit.
      const current = await context.records.get(pending.record.key);
      if (!current || current.revision !== pending.record.revision) return;
      await write(
        context,
        current.key,
        fileType,
        {
          ...pending.previous,
          pending: unknown ? pending.candidate : null,
          state: unknown
            ? 'unknown'
            : pending.previous.first && pending.previous.last
              ? 'captured'
              : 'failed',
        },
        current,
      );
      await write(
        context,
        pending.head.key,
        headType,
        {
          checkpointId: pending.checkpoint.id,
          executionId: context.executionId,
          state: unknown ? 'unknown' : 'idle',
        },
        pending.head,
      );
      tokens.delete(value as object);
    },
  };
  async function records(
    context: FileCheckpointReadContext,
    checkpoint: FileCheckpoint,
  ): Promise<ExtensionRecord[]> {
    const result: ExtensionRecord[] = [];
    let afterKey: string | undefined;
    for (;;) {
      const page = await context.records.list({
        contentType: fileType,
        limit: 200,
        ...(afterKey ? { afterKey } : {}),
      });
      for (const entry of page) {
        const value = decode<FileCheckpointRecord>(entry, fileType);
        if (value.checkpointId === checkpoint.id) {
          file(entry, checkpoint);
          result.push(entry);
        }
      }
      if (page.length < 200)
        return result.sort((a, b) =>
          file(a, checkpoint).path.localeCompare(file(b, checkpoint).path),
        );
      afterKey = page.at(-1)!.key;
    }
  }
  async function readLocalPoint(context: FileCheckpointReadContext, pointId: string) {
    const record = await context.records.get(pointKey(pointId));
    if (!record) fail('checkpoint_not_found');
    const checkpoint = point(record);
    if (checkpoint.boundary.sessionId !== context.sessionId) fail('checkpoint_scope_conflict');
    const key = `checkpoint/${checkpoint.id}/head`;
    const head = await context.records.get(key);
    if (!head) fail('checkpoint_capture_unconfirmed');
    const value = decode<{ checkpointId: string; state: string }>(head, headType);
    if (
      value.checkpointId !== checkpoint.id ||
      head.originStoreId !== checkpoint.boundary.storeId ||
      head.sessionId !== context.sessionId
    )
      fail('checkpoint_scope_conflict');
    const selectedFiles = (await records(context, checkpoint)).map((record) => ({
      revision: record.revision,
      ...file(record, checkpoint),
    }));
    const after = await context.records.get(key);
    if (!after || after.revision !== head.revision || !equal(after.value, head.value))
      fail('checkpoint_refresh_required');
    return {
      checkpoint,
      revision: record.revision,
      head: { key, revision: head.revision, state: value.state },
      files: selectedFiles,
    };
  }
  function snapshotPoint(event: Extract<FileCheckpointForkEvent, { kind: 'capture' }>) {
    const checkpoint = point(event.point);
    const head = decode<{ checkpointId: string; state: string }>(event.head, headType);
    if (
      event.head.key !== `checkpoint/${checkpoint.id}/head` ||
      event.head.sessionId !== checkpoint.boundary.sessionId ||
      event.head.originStoreId !== checkpoint.boundary.storeId ||
      head.checkpointId !== checkpoint.id ||
      checkpoint.boundary.workspaceId !== selected.id ||
      !equal(checkpoint.workspace, workspace)
    )
      fail('checkpoint_scope_conflict');
    return {
      checkpoint,
      revision: event.point.revision,
      head: { key: event.head.key, revision: event.head.revision, state: head.state },
      files: event.files.map((record) => ({
        revision: record.revision,
        ...file(record, checkpoint),
      })),
    };
  }
  async function inherited(context: ReadContext) {
    const record = await context.records.get(forkKey);
    if (!record) return { events: [] as FileCheckpointForkEvent[], projection: null };
    if (
      record.sessionId !== context.sessionId ||
      record.key !== forkKey ||
      !context.openForkSourceProjection
    )
      fail('checkpoint_fork_snapshot_unavailable');
    const snapshot = decode<FileCheckpointForkSnapshot>(record, forkType);
    const projection = await context.openForkSourceProjection(forkKey);
    if (projection.sessionId !== context.sessionId) fail('checkpoint_scope_conflict');
    const ids = new Set<string>();
    for (const event of snapshot.events) {
      if (event.kind === 'capture') {
        const checkpoint = snapshotPoint(event).checkpoint;
        if (ids.has(checkpoint.id)) fail('checkpoint_fork_snapshot_invalid');
        ids.add(checkpoint.id);
      } else if (event.journal.contentVersion !== 2) fail('checkpoint_restore_unconfirmed');
    }
    return { events: snapshot.events, projection };
  }
  async function readPoint(context: FileCheckpointReadContext, pointId: string) {
    const local = await context.records.get(pointKey(pointId));
    if (local) return readLocalPoint(context, pointId);
    const snapshot = await inherited(context);
    const event = snapshot.events.find(
      (event) => event.kind === 'capture' && point(event.point).id === pointId,
    );
    if (!event || event.kind !== 'capture') fail('checkpoint_not_found');
    return snapshotPoint(event);
  }
  async function timeline(context: FileCheckpointReadContext) {
    const snapshot = await inherited(context);
    const records: ExtensionRecord[] = [];
    let afterKey: string | undefined;
    for (;;) {
      const page = await context.records.list({ limit: 200, ...(afterKey ? { afterKey } : {}) });
      records.push(...page);
      if (page.length < 200) break;
      if (page.at(-1)!.key === afterKey) fail('checkpoint_fork_snapshot_invalid');
      afterKey = page.at(-1)!.key;
    }
    const local = fileCheckpointLocalEvents(records, context.sessionId, {
      namespace,
      pointType,
      headType,
      fileType,
      intentType,
      effectType,
      point,
      file,
      decode,
    });
    return { events: [...snapshot.events, ...local], projection: snapshot.projection };
  }
  async function listPoints(
    context: FileCheckpointReadContext,
    options: { afterKey?: string; limit?: number } = {},
  ) {
    const limit = options.limit ?? 50;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (options.afterKey !== undefined &&
        !/^checkpoint\/[a-f0-9]{64}\/point$/.test(options.afterKey))
    )
      fail('checkpoint_page_invalid');
    const page = await context.records.list({
      contentType: pointType,
      limit,
      ...(options.afterKey ? { afterKey: options.afterKey } : {}),
    });
    const local = page.map((record) => ({ checkpoint: point(record), revision: record.revision }));
    if (local.some((item) => item.checkpoint.boundary.sessionId !== context.sessionId))
      fail('checkpoint_scope_conflict');
    const snapshot = await inherited(context);
    const old = snapshot.events.flatMap((event) => {
      if (event.kind !== 'capture') return [];
      const value = snapshotPoint(event);
      return options.afterKey && pointKey(value.checkpoint.id) <= options.afterKey
        ? []
        : [{ checkpoint: value.checkpoint, revision: value.revision }];
    });
    const items = [...local, ...old]
      .sort((a, b) => pointKey(a.checkpoint.id).localeCompare(pointKey(b.checkpoint.id)))
      .slice(0, limit);
    if (new Set(items.map((item) => item.checkpoint.id)).size !== items.length)
      fail('checkpoint_fork_snapshot_invalid');
    return {
      items,
      nextAfterKey: items.length === limit ? pointKey(items.at(-1)!.checkpoint.id) : null,
    };
  }
  async function checkpointLineage(
    context: FileCheckpointReadContext,
    checkpoint: FileCheckpoint,
    projection: ForkSourceProjection | null,
  ) {
    if (!options.readSelectedLineage || !context.readExecutionGroupSafety)
      fail('checkpoint_restore_boundary_unavailable');
    const observation = await context.readExecutionGroupSafety!();
    const lineage = structuredClone(await options.readSelectedLineage(context, checkpoint));
    const decimal = /^(0|[1-9][0-9]*)$/;
    const id = /^[A-Za-z0-9_-]{1,128}$/;
    if (
      observation.sessionId !== context.sessionId ||
      lineage.storeId !== observation.originStoreId ||
      lineage.workspaceId !== selected.id ||
      lineage.sessionId !== context.sessionId ||
      !id.test(lineage.contextSelectionId) ||
      !decimal.test(lineage.upperSeq) ||
      BigInt(lineage.upperSeq) > 9223372036854775807n ||
      !Array.isArray(lineage.messages)
    )
      fail('checkpoint_lineage_invalid');
    const members = new Map<
      string,
      { seq: string; index: number; current: { messageId: string; seq: string } }
    >();
    const identity = (sessionId: string, messageId: string) => `${sessionId}/${messageId}`;
    let previous = -1n;
    for (const [index, message] of lineage.messages.entries()) {
      if (
        !id.test(message.id) ||
        !decimal.test(message.seq) ||
        members.has(identity(context.sessionId, message.id)) ||
        BigInt(message.seq) <= previous ||
        BigInt(message.seq) > BigInt(lineage.upperSeq)
      )
        fail('checkpoint_lineage_invalid');
      previous = BigInt(message.seq);
      members.set(identity(context.sessionId, message.id), {
        seq: message.seq,
        index,
        current: { messageId: message.id, seq: message.seq },
      });
    }
    if (projection) {
      if (projection.storeId !== observation.originStoreId) fail('checkpoint_scope_conflict');
      for (const entry of projection.aliases) {
        const current = members.get(identity(entry.current.sessionId, entry.current.messageId));
        if (!current) continue;
        if (entry.current.sessionId !== context.sessionId || current.seq !== entry.current.seq)
          fail('checkpoint_lineage_invalid');
        for (const alias of entry.aliases) {
          const key = identity(alias.sessionId, alias.messageId);
          const prior = members.get(key);
          if (prior && (prior.seq !== alias.seq || prior.index !== current.index))
            fail('checkpoint_lineage_invalid');
          members.set(key, { seq: alias.seq, index: current.index, current: current.current });
        }
      }
    }
    const selectedPoint = (checkpoint: FileCheckpoint) => {
      const value = checkpoint.boundary;
      const trigger = members.get(identity(value.sessionId, value.triggerMessageId));
      if (!trigger || trigger.seq !== value.triggerSeq) return false;
      const boundary =
        value.messageId === null ? null : members.get(identity(value.sessionId, value.messageId));
      if (
        (value.messageId === null && (value.messageSeq !== '0' || trigger.index !== 0)) ||
        (value.messageId !== null &&
          (!boundary || boundary.seq !== value.messageSeq || boundary.index >= trigger.index))
      )
        fail('checkpoint_lineage_invalid');
      return true;
    };
    return { observation, lineage, members, selectedPoint, identity };
  }
  async function recoveryBoundary(
    context: FileCheckpointReadContext,
    pointId: string,
  ): Promise<FileCheckpointRecoveryBoundary> {
    const target = await readPoint(context, pointId);
    const { projection } = await inherited(context);
    const { observation, lineage, members, selectedPoint, identity } = await checkpointLineage(
      context,
      target.checkpoint,
      projection,
    );
    if (!selectedPoint(target.checkpoint)) fail('checkpoint_branch_not_selected');
    const original = target.checkpoint.boundary;
    const trigger = members.get(identity(original.sessionId, original.triggerMessageId))!;
    const boundary =
      original.messageId === null
        ? null
        : members.get(identity(original.sessionId, original.messageId))!.current;
    const after = await context.readExecutionGroupSafety!();
    if (
      after.originStoreId !== observation.originStoreId ||
      after.sessionId !== observation.sessionId ||
      after.contextRevision !== observation.contextRevision
    )
      fail('checkpoint_lineage_changed');
    return {
      storeId: lineage.storeId,
      sessionId: lineage.sessionId,
      workspaceId: lineage.workspaceId,
      contextSelectionId: lineage.contextSelectionId,
      checkpoint: structuredClone(target.checkpoint),
      boundary: boundary === null ? null : { ...boundary },
      trigger: { ...trigger.current },
    };
  }
  async function restorePlan(context: FileCheckpointReadContext, pointId: string) {
    const target = await readPoint(context, pointId);
    if (
      !options.readSelectedLineage ||
      !options.verifyCaptureSource ||
      !context.readExecutionGroupSafety
    )
      fail('checkpoint_restore_boundary_unavailable');
    const history = await timeline(context);
    const { lineage, selectedPoint } = await checkpointLineage(
      context,
      target.checkpoint,
      history.projection,
    );
    if (!selectedPoint(target.checkpoint)) fail('checkpoint_branch_not_selected');
    const targetIndex = history.events.findIndex(
      (event) => event.kind === 'capture' && point(event.point).id === pointId,
    );
    if (targetIndex < 0) fail('checkpoint_not_found');
    const projection: ForkSourceProjection | null = history.projection;
    const sourceReader = (sessionId: string): ReadContext => {
      if (sessionId === context.sessionId) return context;
      if (!projection) fail('checkpoint_fork_snapshot_unavailable');
      return {
        ...context,
        getRun: (id) => projection.getRun(id),
        getExecution: (id) => projection.getExecution(id),
        artifacts: projection.artifacts,
      };
    };
    async function verifySource(checkpoint: FileCheckpoint, original: CheckpointSource) {
      if (checkpoint.boundary.sessionId === context.sessionId) {
        await options.verifyCaptureSource!(context, checkpoint, structuredClone(original));
        return;
      }
      if (!projection) fail('checkpoint_fork_snapshot_unavailable');
      const binding = projection.sources.find(
        (source) => source.executionId === original.executionId,
      );
      if (
        !binding ||
        binding.kind !== 'tool' ||
        binding.sessionId !== checkpoint.boundary.sessionId ||
        binding.originStoreId !== checkpoint.boundary.storeId ||
        binding.runId !== original.runId ||
        binding.modelExecutionId !== original.modelExecutionId
      )
        fail('checkpoint_source_unconfirmed');
      const input = await projection.readModelInput(original.modelExecutionId);
      if (
        input.confirmation !== 'succeeded' ||
        input.executionId !== original.modelExecutionId ||
        input.sessionId !== checkpoint.boundary.sessionId ||
        input.runId !== checkpoint.boundary.runId ||
        input.bodyHash !== original.modelInputHash
      )
        fail('checkpoint_source_unconfirmed');
      if (selectedPoint(checkpoint)) {
        const trigger = await projection.getMessage(checkpoint.boundary.triggerMessageId);
        if (
          trigger.sessionId !== checkpoint.boundary.sessionId ||
          trigger.seq !== checkpoint.boundary.triggerSeq ||
          trigger.runId !== checkpoint.boundary.runId ||
          trigger.role !== 'user' ||
          trigger.status !== 'complete' ||
          !input.request.messages.some(
            (message) =>
              message.role === 'user' &&
              message.content === trigger.content &&
              equal(message.sourceIds ?? [], trigger.sourceIds ?? [trigger.id]),
          )
        )
          fail('checkpoint_model_boundary_unavailable');
      }
    }
    const rows = new Map<
      string,
      {
        first: Pick<CheckpointPreimage, 'baseline' | 'artifact'>;
        expected: FileBaseline | null;
        artifactExecutionId: string;
        artifacts: ReadContext['artifacts'];
        revision: string;
      }
    >();
    const proofs = history.events.slice(targetIndex);
    for (const event of proofs) {
      if (event.kind === 'capture') {
        const candidate = snapshotPoint(event);
        const checkpoint = candidate.checkpoint;
        const reader = sourceReader(checkpoint.boundary.sessionId);
        const actualRun = await reader.getRun(checkpoint.boundary.runId);
        if (!actualRun || actualRun.sessionId !== checkpoint.boundary.sessionId)
          fail('checkpoint_scope_conflict');
        if (candidate.head.state !== 'idle') fail('checkpoint_capture_unconfirmed');
        for (const entry of candidate.files) {
          if (entry.state !== 'captured' || entry.pending || !entry.first || !entry.last)
            fail('checkpoint_capture_unconfirmed');
          await receipt(reader, checkpoint, entry.first.source, entry.path);
          await receipt(reader, checkpoint, entry.last.source, entry.path, entry.last.baseline);
          await verifySource(checkpoint, entry.first.source);
          await verifySource(checkpoint, entry.last.source);
          const old = rows.get(entry.path);
          if (old && !equal(old.expected, entry.first.baseline))
            fail('checkpoint_capture_chain_conflict');
          rows.set(entry.path, {
            first: old?.first ?? entry.first,
            expected: entry.last.baseline,
            artifactExecutionId: old?.artifactExecutionId ?? entry.first.source.executionId,
            artifacts: old?.artifacts ?? reader.artifacts,
            revision: entry.revision,
          });
        }
      } else {
        const record = event.journal;
        const journal = decode<FileCheckpointRestoreJournal>(record, intentType);
        const reader = sourceReader(record.sessionId);
        const carrier = await reader.getExecution(journal.executionId);
        const failedWithoutEffects = isFailedRestoreWithoutEffects(journal, event.effects);
        if (
          record.contentVersion !== 2 ||
          (journal.phase !== 'restored' && !failedWithoutEffects) ||
          record.key !== restoreKey(journal.id) ||
          carrier?.kind !== 'job' ||
          carrier.status !== (failedWithoutEffects ? 'failed' : 'succeeded') ||
          carrier.runId !== null ||
          carrier.sessionId !== record.sessionId ||
          carrier.originStoreId !== record.originStoreId ||
          carrier.definitionId !== `${namespace}/${restoreDescriptor.id}` ||
          carrier.definitionVersion !== restoreDescriptor.version ||
          carrier.rootWorkSeq !== journal.rootWorkSeq ||
          carrier.inputDigest !==
            digest({
              checkpointId: journal.checkpointId,
              restoreId: journal.id,
              planDigest: journal.planDigest,
            }) ||
          !carrier.result ||
          typeof carrier.result !== 'object' ||
          Array.isArray(carrier.result) ||
          typeof carrier.result.content !== 'string' ||
          !equal(JSON.parse(carrier.result.content), journal)
        )
          fail('checkpoint_restore_unconfirmed');
        // Preserve this failed receipt in the source closure; it supplies no postimage or grant.
        if (failedWithoutEffects) continue;
        if (event.effects.length !== journal.files.length)
          fail('checkpoint_restore_evidence_missing');
        const paths = new Set<string>();
        for (const effectRecord of event.effects) {
          const effect = decode<FileCheckpointRestoreEffect>(effectRecord, effectType);
          const item = journal.files.find((file) => file.path === effect.path);
          if (
            !item ||
            paths.has(effect.path) ||
            effectRecord.sessionId !== record.sessionId ||
            effectRecord.originStoreId !== record.originStoreId ||
            effectRecord.key !==
              `checkpoint/restore/${journal.id}/file/${bytesDigest(Buffer.from(effect.path))}` ||
            effect.restoreId !== journal.id ||
            effect.checkpointId !== journal.checkpointId ||
            effect.executionId !== journal.executionId ||
            effect.rootWorkSeq !== journal.rootWorkSeq ||
            effect.state !== 'confirmed' ||
            !effect.confirmedPost ||
            !item.confirmedPost ||
            !['restored', 'removed', 'unchanged'].includes(item.state) ||
            !equal(effect.expected, item.expected) ||
            !equal(effect.confirmedPost, item.confirmedPost) ||
            (effect.expected === null) !== (effect.beforeImage === null)
          )
            fail('checkpoint_restore_unconfirmed');
          paths.add(effect.path);
          const old = rows.get(effect.path);
          if (old && !equal(old.expected, effect.expected))
            fail('checkpoint_capture_chain_conflict');
          rows.set(effect.path, {
            first: old?.first ?? { baseline: effect.expected, artifact: effect.beforeImage },
            expected: effect.confirmedPost.baseline,
            artifactExecutionId: old?.artifactExecutionId ?? effect.executionId,
            artifacts: old?.artifacts ?? reader.artifacts,
            revision: effectRecord.revision,
          });
        }
      }
    }
    const preview: FileCheckpointPreview = { checkpoint: target.checkpoint, files: [] };
    const bodies = new Map<string, Uint8Array>();
    for (const [path, entry] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
      const item: FileCheckpointPreview['files'][number] = {
        path,
        recordRevision: entry.revision,
        status: 'unavailable',
        reason: null,
        preimage: entry.first.artifact,
        original: entry.first.baseline,
        expected: entry.expected,
      };
      let readingFile = false;
      try {
        if ((entry.first.baseline === null) !== (entry.first.artifact === null))
          fail('checkpoint_artifact_invalid');
        if (entry.first.artifact) {
          const reference = entry.first.artifact;
          if (
            !entry.artifacts ||
            reference.scope?.kind !== 'execution' ||
            reference.scope.id !== entry.artifactExecutionId ||
            reference.size !== String(entry.first.baseline!.size)
          )
            fail('checkpoint_artifact_invalid');
          const bytes = await entry.artifacts.read(reference);
          if (
            bytes.length !== entry.first.baseline!.size ||
            bytes.length > maxBytes ||
            bytesDigest(bytes) !== entry.first.baseline!.hash
          )
            fail('checkpoint_artifact_invalid');
          bodies.set(path, bytes);
        }
        readingFile = true;
        let current: FileBaseline | null;
        try {
          current = (await files.readBytes(path, { maxBytes })).baseline;
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT' || entry.expected !== null)
            throw error;
          current = null;
        }
        if (!equal(current, entry.expected)) {
          item.status = 'conflict';
          item.reason = 'checkpoint_postimage_conflict';
        } else if (
          entry.first.baseline &&
          current?.hash === entry.first.baseline.hash &&
          current?.size === entry.first.baseline.size
        )
          item.status = 'unchanged';
        else
          item.status = entry.first.baseline
            ? 'restore'
            : current === null
              ? 'unchanged'
              : 'remove';
      } catch (error) {
        item.reason = error instanceof AgentError ? error.code : 'checkpoint_read_unavailable';
        if (readingFile) item.status = 'conflict';
      }
      preview.files.push(item);
    }
    // The upper is a paging watermark: answering this Action may advance the shared Session
    // sequence without adding a Message. Bind the complete selected membership, not that counter.
    const { upperSeq: _upper, ...selectedHistory } = lineage;
    return {
      preview,
      bodies,
      planDigest: digest({ lineage: selectedHistory, proofs, preview } as unknown as Json),
    };
  }
  async function preview(
    context: FileCheckpointReadContext,
    pointId: string,
  ): Promise<FileCheckpointPreview> {
    try {
      return (await restorePlan(context, pointId)).preview;
    } catch (error) {
      const target = await readPoint(context, pointId);
      return {
        checkpoint: target.checkpoint,
        files: target.files.map((entry) => ({
          path: entry.path,
          recordRevision: entry.revision,
          status: 'unavailable' as const,
          reason: error instanceof AgentError ? error.code : 'checkpoint_read_unavailable',
          preimage: entry.first?.artifact ?? null,
          original: entry.first?.baseline ?? null,
          expected: entry.last?.baseline ?? null,
        })),
      };
    }
  }
  function restoreKey(restoreId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(restoreId)) fail('checkpoint_restore_id_invalid');
    return `checkpoint/restore/${restoreId}`;
  }
  async function readRestoreIntent(context: ReadContext, pointId: string, restoreId: string) {
    pointKey(pointId);
    const existing = await context.records.get(restoreKey(restoreId));
    if (!existing) return null;
    const value = decode<{ id: string; checkpointId: string }>(existing, intentType);
    if (
      value.id !== restoreId ||
      value.checkpointId !== pointId ||
      existing.sessionId !== context.sessionId
    )
      fail('checkpoint_restore_identity_conflict');
    return existing;
  }
  const restoreResult = async (record: ExtensionRecord, context: ReadContext) => {
    const value = decode<{
      phase: string;
      executionId?: string;
      checkpointId: string;
      id: string;
      planDigest?: string;
    }>(record, intentType);
    let outcome: import('../../extensions').ToolResult['outcome'] = [
      'restoring',
      'outcome_unknown',
    ].includes(value.phase)
      ? 'outcome_unknown'
      : 'failed';
    if (value.phase === 'restored') {
      if ('executionId' in context && context.executionId === value.executionId)
        outcome = 'succeeded';
      else {
        const actual = value.executionId ? await context.getExecution(value.executionId) : null;
        const exact =
          actual?.kind === 'job' &&
          actual.sessionId === context.sessionId &&
          actual.runId === null &&
          actual.definitionId === `${namespace}/${restoreDescriptor.id}` &&
          actual.definitionVersion === restoreDescriptor.version &&
          actual.originStoreId === record.originStoreId &&
          actual.inputDigest ===
            digest({
              checkpointId: value.checkpointId,
              restoreId: value.id,
              planDigest: value.planDigest!,
            });
        outcome = exact && actual.status === 'succeeded' ? 'succeeded' : 'outcome_unknown';
      }
    }
    return { outcome, content: JSON.stringify(record.value) };
  };
  const restoreAction: ActionDefinition = {
    ...restoreDescriptor,
    async prepare(input, context) {
      const value = input as { checkpointId: string; restoreId: string };
      const existing = await readRestoreIntent(context, value.checkpointId, value.restoreId);
      if (existing) return { ...value, replay: true };
      if (!context.requireExecutionGroupQuiescent) fail('checkpoint_restore_boundary_unavailable');
      await context.requireExecutionGroupQuiescent();
      const plan = await restorePlan(context, value.checkpointId);
      if (
        plan.preview.files.some((file) => !['restore', 'remove', 'unchanged'].includes(file.status))
      )
        fail('checkpoint_restore_conflict');
      return { ...value, planDigest: plan.planDigest };
    },
    async execute(prepared, context) {
      const value = prepared as {
        checkpointId: string;
        restoreId: string;
        planDigest?: string;
        replay?: boolean;
      };
      const existing = await readRestoreIntent(context, value.checkpointId, value.restoreId);
      if (existing) return restoreResult(existing, context);
      if (value.replay || !value.planDigest || !context.requireExecutionGroupQuiescent)
        fail('checkpoint_restore_identity_conflict');
      await context.requireExecutionGroupQuiescent();
      const plan = await restorePlan(context, value.checkpointId);
      if (
        plan.planDigest !== value.planDigest ||
        plan.preview.files.some((file) => !['restore', 'remove', 'unchanged'].includes(file.status))
      )
        fail('checkpoint_restore_conflict');
      const carrier = await context.getExecution(context.executionId);
      if (
        carrier?.kind !== 'job' ||
        carrier.runId !== null ||
        carrier.sessionId !== context.sessionId ||
        carrier.definitionId !== `${namespace}/${restoreDescriptor.id}` ||
        carrier.definitionVersion !== restoreDescriptor.version ||
        !['dispatching', 'running'].includes(carrier.status) ||
        typeof carrier.rootWorkSeq !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(carrier.rootWorkSeq)
      )
        fail('checkpoint_restore_identity_conflict');
      let journal: FileCheckpointRestoreJournal = {
        id: value.restoreId,
        checkpointId: value.checkpointId,
        executionId: context.executionId,
        planDigest: plan.planDigest,
        rootWorkSeq: carrier.rootWorkSeq,
        phase: 'restoring',
        files: plan.preview.files.map((file) => ({
          path: file.path,
          operation: file.status as 'restore' | 'remove' | 'unchanged',
          state: 'not_started',
          expected: file.expected!,
          original: file.original,
          preimage: file.preimage,
          confirmedPost: null,
          error: null,
        })),
      };
      let saved = await write(context, restoreKey(value.restoreId), intentType, journal, null);
      for (let index = 0; index < journal.files.length; index++) {
        const entry = journal.files[index]!;
        let published = false;
        let effectRecord: ExtensionRecord | null = null;
        let effect: FileCheckpointRestoreEffect | null = null;
        try {
          await context.requireExecutionGroupQuiescent();
          context.signal.throwIfAborted();
          journal = structuredClone(journal);
          journal.files[index]!.state = 'pending';
          saved = await write(context, saved.key, intentType, journal, saved);
          context.signal.throwIfAborted();
          let beforeImage: CheckpointPreimage['artifact'] = null;
          if (entry.expected !== null) {
            const current = await files.readBytes(entry.path, { maxBytes });
            if (!equal(current.baseline, entry.expected)) fail('checkpoint_postimage_conflict');
            if (!context.artifacts) fail('artifact_publication_unavailable');
            beforeImage = await context.artifacts.publish({
              key: `files.checkpoint.restore.beforeimage.${bytesDigest(Buffer.from(entry.path))}`,
              content: current.bytes,
              mediaType: 'application/octet-stream',
            });
            if (
              beforeImage.scope?.kind !== 'execution' ||
              beforeImage.scope.id !== context.executionId ||
              beforeImage.mediaType !== 'application/octet-stream' ||
              beforeImage.size !== String(entry.expected.size) ||
              bytesDigest(current.bytes) !== entry.expected.hash
            )
              fail('checkpoint_artifact_invalid');
          }
          effect = {
            restoreId: journal.id,
            checkpointId: journal.checkpointId,
            executionId: journal.executionId,
            rootWorkSeq: journal.rootWorkSeq,
            path: entry.path,
            expected: entry.expected,
            beforeImage,
            confirmedPost: null,
            state: 'pending',
          };
          effectRecord = await write(
            context,
            `checkpoint/restore/${journal.id}/file/${bytesDigest(Buffer.from(entry.path))}`,
            effectType,
            effect,
            null,
          );
          context.signal.throwIfAborted();
          if (entry.operation === 'restore') {
            const bytes = plan.bodies.get(entry.path);
            if (!bytes) fail('checkpoint_artifact_invalid');
            const result = await files.restore({
              path: entry.path,
              bytes,
              base: entry.expected,
              maxBytes,
            });
            published = true;
            if (
              result.path !== entry.path ||
              !entry.original ||
              result.baseline.hash !== entry.original.hash ||
              result.baseline.size !== entry.original.size ||
              bytesDigest(result.bytes) !== entry.original.hash ||
              result.bytes.length !== entry.original.size
            )
              fail('checkpoint_restore_confirmation_invalid');
            journal.files[index]!.confirmedPost = { baseline: structuredClone(result.baseline) };
          } else if (entry.operation === 'remove') {
            if (!entry.expected || entry.original !== null)
              fail('checkpoint_restore_confirmation_invalid');
            const result = await files.remove({ path: entry.path, base: entry.expected, maxBytes });
            published = true;
            if (result.path !== entry.path || !equal(result.removedBaseline, entry.expected))
              fail('checkpoint_restore_confirmation_invalid');
            journal.files[index]!.confirmedPost = { baseline: null };
          } else {
            let current: FileBaseline | null;
            try {
              current = (await files.readBytes(entry.path, { maxBytes })).baseline;
            } catch (error) {
              if ((error as { code?: string }).code !== 'ENOENT' || entry.expected !== null)
                throw error;
              current = null;
            }
            if (!equal(current, entry.expected)) fail('checkpoint_postimage_conflict');
            journal.files[index]!.confirmedPost = { baseline: structuredClone(current) };
          }
          journal.files[index]!.state =
            entry.operation === 'remove'
              ? 'removed'
              : entry.operation === 'restore'
                ? 'restored'
                : 'unchanged';
          effect.confirmedPost = journal.files[index]!.confirmedPost;
          effect.state = 'confirmed';
          effectRecord = await write(context, effectRecord.key, effectType, effect, effectRecord);
          saved = await write(context, saved.key, intentType, journal, saved);
        } catch (error) {
          const unknown =
            published || (error as { code?: string }).code === 'file_publish_outcome_unknown';
          journal = structuredClone(journal);
          journal.phase = unknown ? 'outcome_unknown' : 'failed';
          journal.files[index]!.state = unknown ? 'outcome_unknown' : 'failed';
          journal.files[index]!.error =
            error instanceof AgentError ? error.code : 'checkpoint_restore_failed';
          if (effect && effectRecord) {
            effect = { ...effect, state: 'unknown' };
            try {
              await write(context, effectRecord.key, effectType, effect, effectRecord);
            } catch {
              /* An unconfirmed effect never provides a new baseline. */
            }
          }
          try {
            saved = await write(context, saved.key, intentType, journal, saved);
          } catch {
            /* Pending intent remains ineligible; never retry IO. */
          }
          return {
            outcome: unknown ? 'outcome_unknown' : 'failed',
            content: JSON.stringify(journal),
          };
        }
      }
      journal.phase = 'restored';
      try {
        saved = await write(context, saved.key, intentType, journal, saved);
      } catch {
        return {
          outcome: 'outcome_unknown',
          content: JSON.stringify({ ...journal, phase: 'outcome_unknown' }),
        };
      }
      return restoreResult(saved, context);
    },
  };
  async function recordRestoreIntent(context: ActionContext, pointId: string, restoreId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(restoreId)) fail('checkpoint_restore_id_invalid');
    const key = `checkpoint/restore/${restoreId}`;
    const existing = await context.records.get(key);
    if (existing) {
      const value = decode<{ id: string; checkpointId: string }>(existing, intentType);
      if (value.id !== restoreId || value.checkpointId !== pointId)
        fail('checkpoint_restore_identity_conflict');
      return existing;
    }
    const value = await readPoint(context, pointId);
    return write(
      context,
      key,
      intentType,
      {
        id: restoreId,
        checkpointId: pointId,
        phase: 'blocked',
        headRevision: value.head.revision,
        reason: 'checkpoint_restore_boundary_unavailable',
        fileRevisions: value.files.map((file) => ({ path: file.path, revision: file.revision })),
      },
      null,
    );
  }
  const extension = checkpointExtension({
    tools: createFileTools(files, { capture }),
    restore: restoreAction,
    listPoints,
    preview,
    recoveryBoundary,
    readRestoreIntent,
  });
  return {
    extension,
    files,
    listPoints,
    readPoint,
    preview,
    recoveryBoundary,
    recordRestoreIntent,
    readRestoreIntent,
    close: () => files.close(),
  };
}

export type { FileCheckpointReadContext } from './types';

/** Register descriptors without opening a Workspace/Profile; every actual use owns one scoped capability. */
export function createScopedFileCheckpointing(
  resolve: (context: ReadContext) => Promise<ReturnType<typeof createFileCheckpointing>>,
  options: { includeTools?: boolean } = {},
): Extension {
  async function use<T>(
    context: ReadContext,
    operation: (factory: ReturnType<typeof createFileCheckpointing>) => Promise<T>,
  ): Promise<T> {
    const factory = await resolve(context);
    try {
      return await operation(factory);
    } finally {
      await factory.close();
    }
  }
  const restore: ActionDefinition = {
    ...restoreDescriptor,
    prepare: (input, context) =>
      use(context, (factory) =>
        factory.extension
          .actions!.find((action) => action.id === restoreDescriptor.id)!
          .prepare(input, context),
      ),
    execute: (prepared, context) =>
      use(context, (factory) =>
        factory.extension
          .actions!.find((action) => action.id === restoreDescriptor.id)!
          .execute(prepared, context),
      ),
  };
  let tools: readonly ToolDefinition[] | undefined;
  if (options.includeTools) {
    const unavailable = async (): Promise<never> => fail('checkpoint_descriptor_not_executable');
    // The existing builder is pure. This capability has no root/FD and its execute is never retained.
    const descriptorOnly: WorkspaceFiles = {
      readBytes: unavailable,
      restore: unavailable,
      remove: unavailable,
      read: unavailable,
      glob: unavailable,
      write: unavailable,
      edit: unavailable,
      list: unavailable,
      search: unavailable,
      close: unavailable,
    };
    const capture: FileMutationCapture = {
      before: unavailable,
      after: unavailable,
      failed: unavailable,
    };
    tools = createFileTools(descriptorOnly, { capture }).map(
      ({ execute: _unused, ...metadata }) => ({
        ...metadata,
        execute: (input, context) =>
          use(context, (factory) =>
            factory.extension
              .tools!.find((tool) => tool.id === metadata.id && tool.version === metadata.version)!
              .execute(input, context),
          ),
      }),
    );
  }
  return checkpointExtension({
    tools,
    restore,
    listPoints: (context, input) => use(context, (factory) => factory.listPoints(context, input)),
    preview: (context, pointId) => use(context, (factory) => factory.preview(context, pointId)),
    recoveryBoundary: (context, pointId) =>
      use(context, (factory) => factory.recoveryBoundary(context, pointId)),
    readRestoreIntent: (context, pointId, restoreId) =>
      use(context, (factory) => factory.readRestoreIntent(context, pointId, restoreId)),
  });
}
