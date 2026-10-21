import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKnowledgeReadScope,
  type KnowledgeFileAccess,
  KnowledgeReadCleanupError,
  type KnowledgeReadScope,
} from '../../platform/knowledge-reads';
import { createOwnedWorker, ownedWorkerAssets } from '../../platform/process/owned-worker';
import { AgentError } from '../../storage/types';
import {
  type CompiledSkillWorkflow,
  type CompileSkillWorkflowInput,
  SKILL_SCAN_IGNORED_DIRECTORIES,
  type WorkflowCompileSnapshot,
} from '../workflow-contract';
import { readBoundWorkflowFileAsync } from './reference';

export function workflowCompilerAssets() {
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts')
        ? '../../../dist/skills/workflow-contract/worker.js'
        : import.meta.url.endsWith('/business/skill-workflow/index.js')
          ? '../../skills/workflow-contract/worker.js'
          : './skills/workflow-contract/worker.js',
      import.meta.url,
    ),
  );
  const observer = ownedWorkerAssets();
  return Object.freeze({
    worker,
    checksum: worker.replace(/\.js$/, '.sha256'),
    preload: fileURLToPath(observer.preload),
    observerModules: Object.freeze(observer.modules.map((item) => fileURLToPath(item))),
  });
}
async function compilerAsset(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const selected = workflowCompilerAssets();
  const before = await Promise.all([lstat(selected.worker), lstat(selected.checksum)]);
  if (before.some((stat) => !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    throw new AgentError('workflow_compiler_unavailable');
  const [bytes, checksum] = await Promise.all([
    readFile(selected.worker, { signal }),
    readFile(selected.checksum, { encoding: 'utf8', signal }),
  ]);
  signal?.throwIfAborted();
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const after = await Promise.all([lstat(selected.worker), lstat(selected.checksum)]);
  if (
    !/^[a-f0-9]{64}$/.test(checksum.trim()) ||
    hash !== checksum.trim() ||
    after.some(
      (stat, i) =>
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.dev !== before[i]!.dev ||
        stat.ino !== before[i]!.ino ||
        stat.size !== before[i]!.size ||
        stat.mtimeMs !== before[i]!.mtimeMs ||
        stat.ctimeMs !== before[i]!.ctimeMs,
    )
  )
    throw new AgentError('workflow_compiler_unavailable');
  signal?.throwIfAborted();
  return selected.worker;
}

async function snapshot(
  input: CompileSkillWorkflowInput,
  files: KnowledgeFileAccess,
  signal?: AbortSignal,
): Promise<WorkflowCompileSnapshot> {
  const result: WorkflowCompileSnapshot = { diagnostics: [], files: [] };
  signal?.throwIfAborted();
  try {
    const canonicalRoot = await realpath(input.skillDir),
      stat = await lstat(canonicalRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Skill root is not a directory.');
    result.sourceBinding = { canonicalRoot, device: stat.dev, inode: stat.ino };
  } catch (error) {
    result.diagnostics.push({
      code: 'invalid_path',
      message: `Unable to bind Skill source: ${String(error)}`,
    });
    return result;
  }
  const root = result.sourceBinding.canonicalRoot;
  const entries = async (directory: string) => {
    try {
      return (await readdir(directory)).sort((a, b) => a.localeCompare(b));
    } catch (error) {
      result.diagnostics.push({
        code: 'missing_path',
        message: `Unable to read ${directory}: ${String(error)}`,
        path: directory,
      });
      return [];
    }
  };
  const stack = [{ directory: root, entries: await entries(root), index: 0 }];
  while (stack.length) {
    signal?.throwIfAborted();
    const frame = stack.at(-1)!;
    if (frame.index === frame.entries.length) {
      stack.pop();
      continue;
    }
    const name = frame.entries[frame.index++]!;
    if (SKILL_SCAN_IGNORED_DIRECTORIES.has(name)) continue;
    const target = join(frame.directory, name),
      path = relative(root, target);
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink())
        result.diagnostics.push({
          code: 'invalid_path',
          message: `Skill files may not be symbolic links: ${path}`,
          path,
        });
      else if (stat.isDirectory())
        stack.push({ directory: target, entries: await entries(target), index: 0 });
      else if (stat.isFile())
        result.files.push({
          path: path.split(sep).join('/'),
          content: await readBoundWorkflowFileAsync(root, target, stat, files, signal),
        });
    } catch (error) {
      if (error instanceof KnowledgeReadCleanupError || signal?.aborted) throw error;
      result.diagnostics.push({
        code: 'missing_path',
        message: `Unable to read ${path}: ${String(error)}`,
        path,
      });
    }
  }
  signal?.throwIfAborted();
  const end = await lstat(root);
  if (
    !end.isDirectory() ||
    end.dev !== result.sourceBinding.device ||
    end.ino !== result.sourceBinding.inode ||
    (await realpath(input.skillDir)) !== root
  )
    throw new AgentError('workflow_source_changed');
  return result;
}
async function compileOwned(
  input: CompileSkillWorkflowInput,
  value: WorkflowCompileSnapshot,
  signal: AbortSignal | undefined,
  retained: ReturnType<typeof createOwnedWorker>,
  confirm = false,
) {
  signal?.throwIfAborted();
  const owned = retained;
  const { resolveCapability, ...pure } = input;
  const facts = new Map<string, ReturnType<NonNullable<typeof resolveCapability>>>();
  let abort!: () => void;
  try {
    const result = await new Promise<CompiledSkillWorkflow>((resolveResult, reject) => {
      abort = () => reject(signal?.reason ?? new AgentError('cancel_requested'));
      signal?.addEventListener('abort', abort, { once: true });
      owned.worker.onerror = (event) => reject(Error(event.message));
      owned.worker.onmessage = (event) => {
        try {
          if (event.data.kind === 'capabilities') {
            signal?.throwIfAborted();
            for (const id of event.data.ids as string[])
              facts.set(id, structuredClone(resolveCapability?.(id)));
            owned.worker.postMessage({ kind: 'facts', facts: [...facts] });
          } else if (event.data.kind === 'result') resolveResult(event.data.result);
          else if (event.data.kind === 'error') reject(Error(event.data.message));
        } catch (error) {
          reject(error);
        }
      };
      owned.worker.postMessage({
        kind: confirm ? 'confirm' : 'compile',
        input: pure,
        snapshot: value,
        resolver: !!resolveCapability,
      });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    for (const [id, fact] of facts)
      if (JSON.stringify(resolveCapability?.(id)) !== JSON.stringify(fact))
        throw new AgentError('workflow_source_changed');
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
export interface WorkflowCompilerSession {
  run<T>(
    operation: (owned: ReturnType<typeof createOwnedWorker>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  dispose(): Promise<void>;
}
/** One explicit Run-binding CPU resource; no source, dependency or compiled-result cache. */
export function createWorkflowCompilerSession(): WorkflowCompilerSession {
  let owned: ReturnType<typeof createOwnedWorker> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let failure: unknown;
  let disposal: Promise<void> | undefined;
  const stop = async (originalError?: unknown) => {
    if (!owned) return;
    const original = owned;
    try {
      await original.terminate();
      owned = undefined;
    } catch (cleanupError) {
      failure = new KnowledgeReadCleanupError({ originalError, cleanupError, resources: original });
      closed = true;
      throw failure;
    }
  };
  return {
    run(operation, signal) {
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.reject(new AgentError('workflow_compiler_closed'));
      const pending = queue.then(async () => {
        signal?.throwIfAborted();
        if (failure) throw failure;
        if (closed) throw new AgentError('workflow_compiler_closed');
        if (!owned) {
          const asset = await compilerAsset(signal);
          if (closed) throw new AgentError('workflow_compiler_closed');
          signal?.throwIfAborted();
          owned = createOwnedWorker(asset);
        }
        try {
          return await operation(owned);
        } catch (error) {
          await stop(error);
          throw error;
        }
      });
      queue = pending.catch(() => {});
      return pending;
    },
    dispose() {
      if (disposal) return disposal;
      closed = true;
      disposal = queue.then(() => {
        if (failure) throw failure;
        return stop();
      });
      return disposal;
    },
  };
}
export async function compileSkillWorkflowAsync(
  input: CompileSkillWorkflowInput,
  knowledgeScope: KnowledgeReadScope = createKnowledgeReadScope(),
  options: { signal?: AbortSignal; compiler?: WorkflowCompilerSession } = {},
): Promise<CompiledSkillWorkflow> {
  const compiler = options.compiler ?? createWorkflowCompilerSession();
  let result: CompiledSkillWorkflow | undefined;
  let failed = false;
  let originalError: unknown;
  try {
    result = await compiler.run(
      (owned) =>
        knowledgeScope.run(async (files) => {
          const original = await compileOwned(
            input,
            await snapshot(input, files, options.signal),
            options.signal,
            owned,
          );
          const current = await compileOwned(
            input,
            await snapshot(input, files, options.signal),
            options.signal,
            owned,
            true,
          );
          if (
            original.descriptor.revision !== current.descriptor.revision ||
            JSON.stringify(original.sourceBinding) !== JSON.stringify(current.sourceBinding) ||
            JSON.stringify(original.diagnostics) !== JSON.stringify(current.diagnostics)
          )
            throw new AgentError('workflow_source_changed');
          return freeze(current);
        }),
      options.signal,
    );
  } catch (error) {
    failed = true;
    originalError = error;
  }
  if (!options.compiler) await compiler.dispose();
  if (failed) throw originalError;
  return result!;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export async function revalidateSkillWorkflowAsync(
  entry: CompiledSkillWorkflow,
  resolveCapability?: CompileSkillWorkflowInput['resolveCapability'],
  scope?: KnowledgeReadScope,
  options: { signal?: AbortSignal; compiler?: WorkflowCompilerSession } = {},
) {
  const current = await compileSkillWorkflowAsync(
    {
      skillDir: entry.sourcePath,
      source: entry.source,
      origin: entry.origin,
      ...(resolveCapability ? { resolveCapability } : {}),
    },
    scope,
    options,
  );
  if (
    current.descriptor.revision === entry.descriptor.revision &&
    JSON.stringify(current.sourceBinding) === JSON.stringify(entry.sourceBinding)
  )
    return current;
  const changed = {
    code: 'dependency_changed' as const,
    message: 'Skill source or capability dependency changed after compilation.',
  };
  return freeze({
    ...current,
    diagnostics: [...current.diagnostics, changed],
    descriptor: {
      ...current.descriptor,
      availability: 'unavailable' as const,
      diagnostics: [...current.descriptor.diagnostics, `${changed.code}: ${changed.message}`],
    },
  });
}
export async function readWorkflowReferenceAsync(
  entry: CompiledSkillWorkflow,
  path: string,
  resolveCapability?: CompileSkillWorkflowInput['resolveCapability'],
  scope: KnowledgeReadScope = createKnowledgeReadScope(),
  options: { signal?: AbortSignal; compiler?: WorkflowCompilerSession } = {},
) {
  const normalized = path.replaceAll('\\', '/');
  if (
    !entry.contract ||
    entry.descriptor.availability !== 'available' ||
    !entry.sourceBinding ||
    !/^(?:scripts|references|assets|evals)\//.test(normalized) ||
    !entry.contract.files.includes(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..')
  )
    throw Error('skill_reference_not_declared');
  const current = await revalidateSkillWorkflowAsync(entry, resolveCapability, scope, options);
  if (current.descriptor.availability !== 'available') throw Error('skill_workflow_changed');
  const target = resolve(current.sourceBinding!.canonicalRoot, normalized);
  const content = await scope.run(async (files) =>
    readBoundWorkflowFileAsync(
      current.sourceBinding!.canonicalRoot,
      target,
      await lstat(target),
      files,
      options.signal,
    ),
  );
  if (
    (await revalidateSkillWorkflowAsync(entry, resolveCapability, scope, options)).descriptor
      .availability !== 'available'
  )
    throw Error('skill_workflow_changed');
  const { createHash } = await import('node:crypto');
  const utf8 = content.toString('utf8'),
    encoding = Buffer.from(utf8).equals(content) ? ('utf8' as const) : ('base64' as const);
  return {
    path: normalized,
    encoding,
    content: encoding === 'utf8' ? utf8 : content.toString('base64'),
    revision: createHash('sha256').update(content).digest('hex'),
  };
}

/** Exact existing schema validator on the binding-owned CPU worker. */
export async function validateWorkflowArgumentsAsync(
  schema: unknown,
  input: unknown,
  options: { signal?: AbortSignal; compiler?: WorkflowCompilerSession } = {},
): Promise<string | null> {
  const compiler = options.compiler ?? createWorkflowCompilerSession();
  let result: string | null = null;
  let failure: unknown;
  let failed = false;
  try {
    result = await compiler.run(async (owned) => {
      let abort!: () => void;
      try {
        return await new Promise<string | null>((resolveResult, reject) => {
          abort = () => reject(options.signal?.reason ?? new AgentError('cancel_requested'));
          options.signal?.addEventListener('abort', abort, { once: true });
          owned.worker.onerror = (event) => reject(Error(event.message));
          owned.worker.onmessage = (event) => {
            if (event.data.kind === 'validation') resolveResult(event.data.result);
            else if (event.data.kind === 'error') reject(Error(event.data.message));
          };
          owned.worker.postMessage({ kind: 'validate', schema, input });
          if (options.signal?.aborted) abort();
        });
      } finally {
        options.signal?.removeEventListener('abort', abort);
      }
    }, options.signal);
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (!options.compiler) await compiler.dispose();
  if (failed) throw failure;
  return result;
}
