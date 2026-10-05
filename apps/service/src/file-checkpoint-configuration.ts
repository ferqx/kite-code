import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type AgentRuntime, type ModelInputSnapshot } from '@kite-ai/agent';
import type { PublicExecution, ReadContext, ToolContext } from '@kite-ai/agent/extensions';
import {
  type CheckpointSource,
  createFileCheckpointing,
  createScopedFileCheckpointing,
  type FileCheckpoint,
  type FileCheckpointCaptureProof,
} from '@kite-ai/agent/files';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import type {
  ContextSelection,
  ExecutionRecord,
  Json,
  MessageRecord,
} from '@kite-ai/agent/storage';

const maxBytes = 16 * 1024 * 1024;
const maxMessages = 8192;
const maxProofBytes = 64 * 1024 * 1024;
const summaryPrefix = 'Context summary (untrusted data; no additional authorization):\n';
function fail(code = 'checkpoint_source_unverifiable'): never {
  throw new AgentError(code);
}
function object(value: Json): Record<string, Json> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(',')}}`;
}
const digest = (value: Json) => createHash('sha256').update(canonical(value)).digest('hex');
function selected(selection: ContextSelection, seq: string) {
  const value = BigInt(seq);
  return (
    value > BigInt(selection.tailFromSeq) ||
    selection.ranges.some(
      (range) => value > BigInt(range.afterSeq) && value <= BigInt(range.throughSeq),
    )
  );
}
async function canonicalProtection(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalProtection(parent), basename(path));
  }
}
async function protectedPaths(root: string, profile: ProfileSelection, assets: readonly string[]) {
  const paths = ['.git'];
  if (assets.length > 128 || assets.some((path) => !isAbsolute(path) || path.length > 4096))
    fail('checkpoint_runtime_assets_invalid');
  for (const path of [profile.dataRoot, profile.profilePath, profile.coordinationPath, ...assets]) {
    const actual = await canonicalProtection(resolve(path));
    const within = relative(root, actual);
    const parent = relative(actual, root);
    if (
      within === '' ||
      parent === '' ||
      (!isAbsolute(parent) && !parent.split(/[\\/]/).includes('..'))
    )
      fail('checkpoint_workspace_protected');
    if (!isAbsolute(within) && !within.split(/[\\/]/).includes('..'))
      paths.push(within.split(/[\\/]/).join('/'));
  }
  return [...new Set(paths)];
}

/** Trusted default assembly; public IDs and the current view cannot prove a consumed Model input. */
export function createDefaultFileCheckpointConfiguration(options: {
  profile: ProfileSelection;
  runtime(): AgentRuntime;
  /** Actual trusted loader selections, never Model, JSONC or a public query. Called only in scope. */
  runtimeAssets(): readonly string[];
}) {
  async function scope(context: ReadContext) {
    const runtime = options.runtime();
    if (!context.readExecutionGroupSafety) fail('checkpoint_scope_unavailable');
    const group = await context.readExecutionGroupSafety();
    const metadata = await runtime.getMetadata();
    const session = await runtime.getSession(context.sessionId);
    const workspace = session && (await runtime.getWorkspace(session.workspaceId));
    if (
      !session ||
      session.deletedAt !== null ||
      !workspace ||
      group.sessionId !== session.id ||
      group.rootSessionId !== session.rootSessionId ||
      group.originStoreId !== metadata.storeId
    )
      fail('checkpoint_scope_conflict');
    let path: string;
    try {
      path = fileURLToPath(workspace.rootUri);
    } catch {
      return fail('checkpoint_scope_conflict');
    }
    const root = await realpath(path);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('checkpoint_scope_conflict');
    return { runtime, storeId: metadata.storeId, session, workspace, root };
  }
  type Scope = Awaited<ReturnType<typeof scope>>;
  async function history(
    bound: Scope,
    original?: { runId: string; subjectId: string; upperSeq: string },
  ) {
    const { runtime, storeId, session } = bound;
    const page = original
      ? await runtime.readOriginalRunSelection({
          expectedStoreId: storeId,
          sessionId: session.id,
          subjectId: original.subjectId,
          runId: original.runId,
        })
      : await runtime.getSelectedContext({
          expectedStoreId: storeId,
          sessionId: session.id,
          contextSelectionId: session.contextSelectionId,
          messageLimit: 1,
          sourceLimit: 1,
          byteLimit: 8 * 1024 * 1024,
        });
    const upperSeq = original?.upperSeq ?? page.highWaterSeq;
    if (!/^(0|[1-9][0-9]*)$/.test(upperSeq) || BigInt(upperSeq) > BigInt(page.highWaterSeq))
      fail('checkpoint_lineage_invalid');
    const selection = page.selection;
    const messages: MessageRecord[] = [];
    const executions = new Map<string, Promise<ExecutionRecord | null>>();
    let afterSeq = '0';
    let bytes = 0;
    for (;;) {
      const rows = await runtime.listMessages(session.id, {
        afterSeq,
        upperSeq,
        limit: 200,
      });
      for (const row of rows) {
        if (
          row.sessionId !== session.id ||
          BigInt(row.seq) <= BigInt(afterSeq) ||
          BigInt(row.seq) > BigInt(upperSeq)
        )
          fail('checkpoint_lineage_invalid');
        afterSeq = row.seq;
        if (row.status !== 'complete' || !selected(selection, row.seq)) continue;
        // Use the same actual source relation as Core's compression-history exclusion.
        let compressionHistory = false;
        for (const id of row.sourceIds ?? []) {
          if (!executions.has(id)) executions.set(id, runtime.getExecution(id));
          const execution = await executions.get(id)!;
          if (
            row.role === 'assistant' &&
            execution?.kind === 'model' &&
            object(execution.decisionSource)?.compressionId !== undefined
          )
            compressionHistory = true;
        }
        if (compressionHistory) continue;
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (messages.length >= maxMessages || bytes > maxProofBytes)
          fail('checkpoint_lineage_too_large');
        messages.push(row);
      }
      if (rows.length < 200) break;
    }
    const current = await runtime.getSession(session.id);
    if (
      current?.contextSelectionId !== session.contextSelectionId ||
      current.workspaceId !== session.workspaceId ||
      current.deletedAt !== null ||
      (await runtime.getMetadata()).storeId !== storeId
    )
      fail('checkpoint_refresh_required');
    return { messages, selection, upperSeq };
  }
  async function consumedUsers(
    bound: Scope,
    snapshot: ModelInputSnapshot,
    subjectId: string,
    signal?: AbortSignal,
  ) {
    const users: { sourceIds: readonly string[]; content: string }[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    async function expand(input: ModelInputSnapshot, depth: number) {
      signal?.throwIfAborted();
      if (depth >= 32 || seen.has(input.executionId)) fail('checkpoint_compression_unverifiable');
      seen.add(input.executionId);
      bytes += Number(input.bodyBytes);
      if (!Number.isSafeInteger(bytes) || bytes > maxProofBytes)
        fail('checkpoint_model_proof_too_large');
      const entries = input.request.messages.filter((message) => message.role === 'user');
      const execution = await bound.runtime.getExecution(input.executionId);
      const compressionId = execution && object(execution.decisionSource)?.compressionId;
      if (typeof compressionId === 'string') {
        const origin = await bound.runtime.getCompressionOrigin({
          expectedStoreId: bound.storeId,
          sessionId: input.sessionId,
          subjectId,
          compressionId,
        });
        const instruction = entries.at(-1);
        if (
          origin.modelExecutionId !== input.executionId ||
          origin.originSessionId !== input.sessionId ||
          instruction?.sourceIds?.length !== 1 ||
          instruction.sourceIds[0] !== compressionId
        )
          fail('checkpoint_compression_unverifiable');
        // Core appends one generated compression instruction. It is not a consumed user Message.
        entries.pop();
      }
      let summaryRemoved = false;
      for (const entry of entries) {
        const ids = entry.sourceIds ?? [];
        // Prefix only locates a candidate. A published original record and full output must prove it.
        if (
          !summaryRemoved &&
          ids.length === 1 &&
          ids[0]!.startsWith('compression-') &&
          entry.content.startsWith(summaryPrefix)
        ) {
          let origin: Awaited<ReturnType<AgentRuntime['getCompressionOrigin']>> | undefined;
          try {
            origin = await bound.runtime.getCompressionOrigin({
              expectedStoreId: bound.storeId,
              sessionId: input.sessionId,
              subjectId,
              compressionId: ids[0]!,
            });
          } catch (error) {
            if (!(error instanceof AgentError) || error.code !== 'compression_scope_denied')
              throw error;
          }
          if (origin) {
            const output = await bound.runtime.readModelOutput({
              expectedStoreId: bound.storeId,
              sessionId: origin.originSessionId,
              subjectId,
              executionId: origin.modelExecutionId,
              signal,
            });
            if (!output.output.complete || entry.content !== summaryPrefix + output.output.content)
              fail('checkpoint_compression_unverifiable');
            summaryRemoved = true;
            const original = await bound.runtime.readModelInput({
              expectedStoreId: bound.storeId,
              sessionId: origin.originSessionId,
              subjectId,
              executionId: origin.modelExecutionId,
              signal,
            });
            if (original.confirmation !== 'succeeded' || original.runId !== origin.runId)
              fail('checkpoint_compression_unverifiable');
            await expand(original, depth + 1);
            continue;
          }
        }
        users.push({ sourceIds: ids, content: entry.content });
      }
    }
    await expand(snapshot, 0);
    return users;
  }
  async function captureProof(
    context: ReadContext,
    executionId: string,
    expected?: FileCheckpoint,
    signal?: AbortSignal,
  ): Promise<FileCheckpointCaptureProof> {
    const bound = await scope(context);
    const { runtime, storeId, session, workspace } = bound;
    const tool = await runtime.getExecution(executionId);
    const source = tool && object(tool.decisionSource);
    const model =
      typeof source?.modelExecutionId === 'string'
        ? await runtime.getExecution(source.modelExecutionId)
        : null;
    const run = tool?.runId && (await runtime.getRun(tool.runId));
    const command = run && (await runtime.getCommand(run.originCommandId));
    if (
      !tool ||
      !model ||
      !run ||
      !command ||
      source?.kind !== 'model_decision' ||
      tool.kind !== 'tool' ||
      !['files.write', 'files.edit'].includes(tool.definitionId) ||
      tool.definitionVersion !== '2' ||
      tool.sessionId !== session.id ||
      tool.originStoreId !== (expected?.boundary.storeId ?? storeId) ||
      tool.originCommandId !== command.id ||
      tool.rootWorkCommandId !== run.rootWorkCommandId ||
      model.kind !== 'model' ||
      model.status !== 'succeeded' ||
      model.sessionId !== session.id ||
      model.runId !== run.id ||
      model.originCommandId !== command.id ||
      model.originStoreId !== tool.originStoreId ||
      command.sessionId !== session.id ||
      command.originStoreId !== tool.originStoreId ||
      run.sessionId !== session.id ||
      run.originStoreId !== tool.originStoreId ||
      !run.contextSelectionId ||
      (tool.contextSelectionId !== null && tool.contextSelectionId !== run.contextSelectionId) ||
      (model.contextSelectionId !== null && model.contextSelectionId !== run.contextSelectionId) ||
      (expected
        ? tool.status !== 'succeeded'
        : !run.isActive ||
          !['dispatching', 'running'].includes(tool.status) ||
          run.contextSelectionId !== session.contextSelectionId)
    )
      fail();
    const snapshot = await runtime.readModelInput({
      expectedStoreId: storeId,
      sessionId: session.id,
      subjectId: command.subjectId,
      executionId: model.id,
      signal,
    });
    if (
      snapshot.confirmation !== 'succeeded' ||
      snapshot.runId !== run.id ||
      snapshot.originCommandId !== command.id ||
      snapshot.rootWorkCommandId !== run.rootWorkCommandId
    )
      fail();
    const actual = await history(
      bound,
      expected
        ? { runId: run.id, subjectId: command.subjectId, upperSeq: expected.boundary.triggerSeq }
        : undefined,
    );
    if (actual.selection.id !== run.contextSelectionId) fail('checkpoint_model_boundary_conflict');
    const users = await consumedUsers(bound, snapshot, command.subjectId, signal);
    const trigger = actual.messages
      .filter(
        (message) =>
          message.runId === run.id &&
          message.role === 'user' &&
          users.some(
            (user) =>
              canonical([...user.sourceIds]) === canonical(message.sourceIds ?? [message.id]) &&
              user.content === message.content,
          ),
      )
      .at(-1);
    if (!trigger) fail('checkpoint_model_boundary_unavailable');
    const before = actual.messages
      .filter((message) => BigInt(message.seq) < BigInt(trigger.seq))
      .at(-1);
    const boundary = {
      storeId: tool.originStoreId,
      workspaceId: workspace.id,
      sessionId: session.id,
      runId: run.id,
      contextSelectionId: run.contextSelectionId,
      messageId: before?.id ?? null,
      messageSeq: before?.seq ?? '0',
      triggerMessageId: trigger.id,
      triggerSeq: trigger.seq,
    };
    if (expected && canonical(boundary) !== canonical(expected.boundary as unknown as Json))
      fail('checkpoint_model_boundary_conflict');
    signal?.throwIfAborted();
    return { boundary, modelExecutionId: model.id, modelInputHash: snapshot.bodyHash };
  }
  const extension = createScopedFileCheckpointing(
    async (context) => {
      const bound = await scope(context);
      return createFileCheckpointing({
        workspace: { id: bound.workspace.id, root: bound.root },
        maxBytes,
        protectedPaths: await protectedPaths(bound.root, options.profile, options.runtimeAssets()),
        protectReads: true,
        async readBoundary(context: ToolContext, actual: Readonly<PublicExecution>) {
          if (actual.id !== context.executionId) fail('checkpoint_scope_conflict');
          const tool = await bound.runtime.getExecution(actual.id);
          if (!tool || actual.inputDigest !== digest(tool.input)) fail();
          return captureProof(context, actual.id, undefined, context.signal);
        },
        async readSelectedLineage(context, point) {
          const current = await scope(context);
          if (point.boundary.workspaceId !== current.workspace.id)
            fail('checkpoint_scope_conflict');
          const selected = await history(current);
          return {
            storeId: current.storeId,
            workspaceId: current.workspace.id,
            sessionId: current.session.id,
            contextSelectionId: selected.selection.id,
            upperSeq: selected.upperSeq,
            messages: selected.messages.map(({ id, seq }) => ({ id, seq })),
          };
        },
        async verifyCaptureSource(context, point, source: Readonly<CheckpointSource>) {
          const proof = await captureProof(context, source.executionId, point);
          const tool = await bound.runtime.getExecution(source.executionId);
          if (
            !tool ||
            proof.modelExecutionId !== source.modelExecutionId ||
            proof.modelInputHash !== source.modelInputHash ||
            tool.runId !== source.runId ||
            tool.definitionId !== source.definitionId ||
            tool.definitionVersion !== source.definitionVersion ||
            tool.attempt !== source.attempt ||
            digest(tool.input) !== source.inputDigest
          )
            fail();
        },
      });
    },
    { includeTools: true },
  );
  return { extension, tools: extension.tools ?? [] };
}
