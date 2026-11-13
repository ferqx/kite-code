import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { setImmediate as yieldIo } from 'node:timers/promises';
import type { Extension, JobContext, JobHandle, ToolResult } from '../extensions';
import {
  type LaunchIdentity,
  launchIdentityAsync,
  removeRuntimeTempAsync,
} from '../jobs/launch-identity';
import { canonicalJson } from '../json';
import { privateDirectory } from '../maintenance/files';
import {
  type ExpectedOutputFile,
  type OutputCollection,
  type OutputFileRecord,
  type OutputSourceIdentity,
  outputCollectionLimits,
} from '../output-files';
import type { AgentRuntime } from '../runtime';
import type { Json } from '../storage/types';
import { AgentError } from '../storage/types';
import {
  createWorkspaceFileIo,
  type WorkspaceFileIo,
  type WorkspaceFileStat,
} from '../tools/files-io';

const identity = (s: WorkspaceFileStat): OutputSourceIdentity => ({
  device: String(s.dev),
  inode: String(s.ino),
  size: String(s.size),
  mtimeNs: String(s.mtimeNs),
  ctimeNs: String(s.ctimeNs),
});
const retainedIo = new Set<WorkspaceFileIo>();
function closeIo(io: WorkspaceFileIo) {
  try {
    io.close();
  } catch (error) {
    retainedIo.add(io);
    throw error;
  }
}
const equal = (a: unknown, b: unknown) => canonicalJson(a as Json) === canonicalJson(b as Json);
const code = (error: unknown) =>
  error instanceof AgentError
    ? error.code
    : error instanceof Error && /^[a-z][a-z0-9_]{1,80}$/.test(error.message)
      ? error.message
      : 'output_collection_io_failed';
async function directory(fact: LaunchIdentity) {
  const s = await lstat(fact.path, { bigint: true });
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    String(s.dev) !== fact.device ||
    String(s.ino) !== fact.inode ||
    (await realpath(fact.path)) !== fact.canonical
  )
    throw new AgentError('output_root_changed');
}
async function openRoot(c: OutputCollection) {
  const fact = c.allocation.outputIdentity;
  // Path safety and native object identity are separate proofs. Bun's Windows
  // lstat identity is not FILE_ID_INFO (in particular its volume ID is narrower).
  const pathStat = await lstat(fact.path, { bigint: true });
  if (
    !pathStat.isDirectory() ||
    pathStat.isSymbolicLink() ||
    (await realpath(fact.path)) !== fact.canonical
  )
    throw new AgentError('output_root_changed');
  const io = createWorkspaceFileIo(fact.canonical, [], true);
  try {
    io.verifyRoot();
    const s = io.stat(io.root);
    if (!s.isDirectory() || String(s.dev) !== fact.device || String(s.ino) !== fact.inode)
      throw new AgentError('output_root_changed');
    return io;
  } catch (error) {
    closeIo(io);
    throw error;
  }
}
function openFile(io: WorkspaceFileIo, path: string) {
  let parent = io.root;
  const handles: number[] = [];
  try {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const next = io.openAt(
        parent,
        parts[i]!,
        i === parts.length - 1 ? 'read' : 'directory',
        true,
      );
      handles.push(next);
      parent = next;
    }
    const s = io.stat(parent);
    if (!s.isFile() || s.nlink !== 1n) throw new AgentError('output_file_unsafe');
    return {
      handle: parent,
      close() {
        for (const id of handles.reverse()) io.closeHandle(id);
      },
    };
  } catch (error) {
    for (const id of handles.reverse()) io.closeHandle(id);
    throw error;
  }
}
/** Complete bounded enumeration through held native directory handles. */
export async function enumerateOutputFiles(
  c: OutputCollection,
  signal: AbortSignal,
): Promise<ExpectedOutputFile[]> {
  await directory(c.allocation.identity);
  const io = await openRoot(c);
  const result: ExpectedOutputFile[] = [];
  let total = 0n;
  let entries = 0;
  async function walk(parent: number, relative: string, depth: number) {
    signal.throwIfAborted();
    if (depth > outputCollectionLimits.depth) throw new AgentError('output_depth_limit');
    await yieldIo();
    signal.throwIfAborted();
    let children: ReturnType<WorkspaceFileIo['listAt']>;
    try {
      children = io.listAt(parent, outputCollectionLimits.entries - entries);
    } catch (error) {
      if (error instanceof AgentError && error.code === 'file_directory_entry_limit')
        throw new AgentError('output_entry_limit');
      throw error;
    } finally {
      await yieldIo();
      signal.throwIfAborted();
    }
    entries += children.length;
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      await yieldIo();
      signal.throwIfAborted();
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name.includes('\\') || !['file', 'directory'].includes(entry.kind))
        throw new AgentError('output_file_unsafe');
      const handle = io.openAt(
        parent,
        entry.name,
        entry.kind === 'directory' ? 'directory' : 'read',
        true,
      );
      try {
        const stat = io.stat(handle);
        if (entry.kind === 'directory') {
          await walk(handle, path, depth + 1);
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1n) throw new AgentError('output_file_unsafe');
        if (stat.size > BigInt(outputCollectionLimits.fileBytes))
          throw new AgentError('output_size_limit');
        total += stat.size;
        if (total > BigInt(outputCollectionLimits.batchBytes))
          throw new AgentError('output_batch_limit');
        result.push({ relativePath: path, sourceIdentity: identity(stat) });
        if (result.length > outputCollectionLimits.files) throw new AgentError('output_file_limit');
      } finally {
        io.closeHandle(handle);
      }
      await yieldIo();
    }
  }
  try {
    await walk(io.root, '', 1);
    io.verifyRoot();
    return result;
  } finally {
    closeIo(io);
  }
}
export async function prepareOutputDirectory(
  runtime: AgentRuntime,
  context: JobContext,
  identity: LaunchIdentity,
) {
  await directory(identity);
  const path = join(identity.canonical, 'out');
  await mkdir(path, { mode: 0o700 });
  const outputIdentity = await launchIdentityAsync(path, false, context.signal);
  const io = createWorkspaceFileIo(outputIdentity.canonical, [], true);
  let nativeIdentity: { device: string; inode: string };
  try {
    await directory(identity);
    await directory(outputIdentity);
    io.verifyRoot();
    const stat = io.stat(io.root);
    // Persist the same full native identity that collection will later verify.
    // The producer LaunchIdentity remains unchanged for launch and cleanup.
    nativeIdentity = { device: String(stat.dev), inode: String(stat.ino) };
  } finally {
    closeIo(io);
  }
  context.signal.throwIfAborted();
  await runtime.allocateShellOutput(context, identity, { ...outputIdentity, ...nativeIdentity });
  return { env: { KITE_OUTPUT_DIR: path }, cleanupTransferred: true as const };
}
function media(path: string) {
  return (
    (
      {
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.csv': 'text/csv',
      } as Record<string, string>
    )[extname(path).toLowerCase()] ?? 'application/octet-stream'
  );
}
export async function collectOutputFiles(
  runtime: AgentRuntime,
  context: JobContext,
  collectionId: string,
  attempt: number,
): Promise<ToolResult> {
  let c = await runtime.mutateShellOutput(context, { kind: 'bind', collectionId, attempt });
  const errors: OutputCollection['errors'] = [];
  try {
    if (c.expectedFiles === null)
      c = await runtime.mutateShellOutput(context, {
        kind: 'freeze',
        collectionId,
        expectedRevision: c.revision,
        entries: await enumerateOutputFiles(c, context.signal),
      });
    for (const expected of c.expectedFiles!) {
      context.signal.throwIfAborted();
      try {
        const fileId = createHash('sha256')
          .update(
            JSON.stringify([c.source.storeId, c.source.sessionId, c.id, expected.relativePath]),
          )
          .digest('hex');
        try {
          await runtime.resolveOutputFile({
            expectedStoreId: c.source.storeId,
            sessionId: c.source.sessionId,
            subjectId: c.source.subjectId,
            target: {
              storeId: c.source.storeId,
              sessionId: c.source.sessionId,
              fileId,
              locator: {
                kind: 'delivery',
                key: `delivery/${BigInt(c.source.runOriginSeq).toString().padStart(20, '0')}/${c.source.producerExecutionId}/${fileId}`,
              },
            },
          });
          continue;
        } catch (error) {
          if (!(error instanceof AgentError) || error.code !== 'output_file_not_found') throw error;
        }
        await directory(c.allocation.identity);
        const io = await openRoot(c);
        let selected: ReturnType<typeof openFile> | undefined;
        try {
          selected = openFile(io, expected.relativePath);
          const handle = selected.handle;
          const before = io.stat(handle);
          if (!equal(identity(before), expected.sourceIdentity))
            throw new AgentError('output_source_changed');
          async function* chunks() {
            const buffer = Buffer.allocUnsafe(64 * 1024);
            for (;;) {
              context.signal.throwIfAborted();
              const size = io.read(handle, buffer);
              if (!size) break;
              yield buffer.subarray(0, size);
              await yieldIo();
            }
            if (!equal(identity(io.stat(handle)), expected.sourceIdentity))
              throw new AgentError('output_source_changed');
            io.verifyRoot();
            const again = openFile(io, expected.relativePath);
            try {
              if (!equal(identity(io.stat(again.handle)), expected.sourceIdentity))
                throw new AgentError('output_source_changed');
            } finally {
              again.close();
            }
          }
          const fileId = createHash('sha256')
            .update(
              JSON.stringify([c.source.storeId, c.source.sessionId, c.id, expected.relativePath]),
            )
            .digest('hex');
          const reference = await runtime.publishShellOutput(
            context,
            c,
            `output-file-${fileId}`,
            media(expected.relativePath),
            chunks(),
          );
          c = await runtime.mutateShellOutput(context, {
            kind: 'commit',
            collectionId,
            relativePath: expected.relativePath,
            reference,
          });
        } finally {
          selected?.close();
          closeIo(io);
        }
      } catch (error) {
        errors.push({ relativePath: expected.relativePath, code: code(error) });
      }
    }
  } catch (error) {
    errors.push({ code: context.signal.aborted ? 'output_collection_cancelled' : code(error) });
  }
  c = await runtime.mutateShellOutput(context, {
    kind: 'settle',
    collectionId,
    expectedRevision: c.revision,
    errors,
  });
  if (c.state === 'ready') await removeRuntimeTempAsync(c.allocation.identity);
  return {
    outcome: errors.some((error) => error.code === 'file_close_unknown')
      ? 'outcome_unknown'
      : c.state === 'ready'
        ? 'succeeded'
        : 'failed',
    content:
      c.state === 'ready' ? 'output_collection_ready' : (c.errorCode ?? 'output_collection_failed'),
  };
}
/** Decorates the existing Files namespace; no new model tools or definitions. */
export function withOutputCollection(extension: Extension, runtime: () => AgentRuntime): Extension {
  if (extension.id !== 'builtin.files') throw new AgentError('output_namespace_invalid');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['collectionId', 'attempt'],
    properties: { collectionId: { type: 'string' }, attempt: { type: 'integer', minimum: 1 } },
  };
  const handles = new WeakMap<
    JobHandle,
    {
      context: JobContext;
      input: { collectionId: string; attempt: number };
      task?: Promise<ToolResult>;
      controller: AbortController;
      done: boolean;
    }
  >();
  const state = (h: JobHandle) => {
    const s = handles.get(h);
    if (!s) throw new AgentError('output_handle_invalid');
    return s;
  };
  return {
    ...extension,
    records: [
      ...(extension.records ?? []),
      ...['allocation', 'collection'].map((kind) => ({
        contentType: `builtin.files.${kind}`,
        contentVersion: 1,
        schema: { type: 'object' },
        fork: { mode: 'omit' as const },
      })),
      {
        contentType: 'builtin.files.delivery',
        contentVersion: 1,
        schema: { type: 'object' },
        fork: {
          mode: 'rebuild',
          version: '1',
          sourceScope: 'namespace',
          sourceReads: 'declared',
          onUnsupported: 'reject',
          async prepare(input) {
            const selected = new Set(input.selectedMessages.flatMap((m) => m.sourceIds));
            return input.records.flatMap((record) => {
              const value = record.value as unknown as OutputFileRecord;
              const inherited = !!record.forkProvenance;
              const collection = value.collectionId
                ? input.namespaceRecords?.find((r) => r.key === value.collectionId)
                : undefined;
              const tool = (collection?.value as unknown as OutputCollection | undefined)?.source
                .producerToolExecutionId;
              if (!inherited && !selected.has(tool ?? value.sourceExecutionId)) return [];
              return [
                {
                  key: record.key,
                  contentType: record.contentType,
                  contentVersion: record.contentVersion,
                  value: record.value,
                  readonlySources: [
                    inherited
                      ? {
                          kind: 'inherited' as const,
                          anchorKey: record.key,
                          executionId: value.sourceExecutionId,
                          artifactRefIds: [value.reference.id],
                        }
                      : {
                          kind: 'execution' as const,
                          executionId: value.sourceExecutionId,
                          executionKind: value.collectionId ? ('job' as const) : ('tool' as const),
                          artifactRefIds: [value.reference.id],
                        },
                  ],
                },
              ];
            });
          },
        },
      },
    ],
    actions: [
      ...(extension.actions ?? []),
      {
        id: 'collect-outputs',
        version: '1',
        description: 'Register one host file collector.',
        inputSchema: schema,
        async prepare(input) {
          return input;
        },
        async execute(input, context) {
          const v = input as { collectionId: string; attempt: number };
          await runtime().verifyOutputCollectionAction(context.executionId, v);
          await context.operations.ensure({
            key: `collect/${v.collectionId}/${v.attempt}`,
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: 'builtin.files/collect',
              definitionVersion: '1',
              input,
            },
          });
          return { outcome: 'succeeded', content: 'collection_registered' };
        },
      },
    ],
    jobs: [
      ...(extension.jobs ?? []),
      {
        id: 'builtin.files/collect',
        version: '1',
        description: 'Archive explicitly delivered Shell files.',
        inputSchema: schema,
        resources: { serial: { scope: 'runtime', key: 'builtin.files.output-collection' } },
        async start(input, context) {
          const handle = { reference: input };
          handles.set(handle, {
            context,
            input: input as { collectionId: string; attempt: number },
            controller: new AbortController(),
            done: false,
          });
          return handle;
        },
        async *observe(handle) {
          const s = state(handle);
          s.task ??= collectOutputFiles(
            runtime(),
            { ...s.context, signal: AbortSignal.any([s.context.signal, s.controller.signal]) },
            s.input.collectionId,
            s.input.attempt,
          ).finally(() => {
            s.done = true;
          });
          const result = await s.task;
          yield {
            type: 'terminal',
            result,
            supervision: result.outcome === 'outcome_unknown' ? 'unknown' : 'ended',
          };
        },
        async cancel(handle) {
          const s = state(handle);
          s.controller.abort();
          return { status: s.done ? 'already_finished' : 'requested' };
        },
        async dispose(handle) {
          const s = state(handle);
          if (s.task && (await s.task).outcome === 'outcome_unknown')
            throw new AgentError('output_cleanup_unknown');
          handles.delete(handle);
        },
      },
    ],
  };
}

/** Trusted host staging base, validated before platform launch preparation. */
export function prepareOutputStaging(base: string): string {
  return privateDirectory(base, true);
}
