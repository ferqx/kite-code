import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createKnowledgeReadScope, type KnowledgeReadScope } from '../../platform/knowledge-reads';
import {
  type CompiledSkillWorkflow,
  revalidateSkillWorkflowAsync,
  type WorkflowCapability,
  type WorkflowCompilerSession,
} from '../../skills/workflow-contract';
import { readBoundWorkflowFileAsync } from '../../skills/workflow-contract/reference';
import { digestWorkflowValue } from '../../skills/workflow-contract/schema';
import { AgentError } from '../../storage/types';

export function directoryIdentity(path: string) {
  const canonical = realpathSync.native(path),
    stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AgentError('workflow_compensation_path_invalid');
  return { path, canonical, device: stat.dev, inode: stat.ino };
}
export function assertDirectory(identity: ReturnType<typeof directoryIdentity>) {
  const current = directoryIdentity(identity.path);
  if (
    current.canonical !== identity.canonical ||
    current.device !== identity.device ||
    current.inode !== identity.inode
  )
    throw new AgentError('workflow_compensation_path_changed');
}
export function within(root: string, target: string) {
  const scope = relative(root, target);
  return scope === '' || (!isAbsolute(scope) && scope !== '..' && !scope.startsWith(`..${sep}`));
}

/** Full original byte set, including binary assets; a copy cannot gain a new compiled identity. */
export async function sealCompensationAssets(
  entry: CompiledSkillWorkflow,
  base: string,
  resolveCapability?: (id: string) => WorkflowCapability | undefined,
  knowledgeScope: KnowledgeReadScope = createKnowledgeReadScope(),
  signal?: AbortSignal,
  compiler?: WorkflowCompilerSession,
) {
  const current = await revalidateSkillWorkflowAsync(entry, resolveCapability, knowledgeScope, {
    signal,
    compiler,
  });
  if (
    !current.contract ||
    !current.sourceBinding ||
    current.descriptor.availability !== 'available' ||
    current.descriptor.revision !== entry.descriptor.revision
  )
    throw new AgentError('workflow_source_changed');
  const digest = createHash('sha256');
  const files: { path: string; content: Buffer }[] = [];
  for (const path of current.contract.files) {
    signal?.throwIfAborted();
    if (!path || path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new AgentError('workflow_compensation_path_invalid');
    const target = join(current.sourceBinding!.canonicalRoot, path);
    const content = await knowledgeScope.run(async (access) =>
      readBoundWorkflowFileAsync(
        current.sourceBinding!.canonicalRoot,
        target,
        await lstat(target),
        access,
        signal,
      ),
    );
    digest.update(path).update('\0').update(String(content.byteLength)).update('\0');
    for (let offset = 0; offset < content.byteLength; offset += 65536) {
      signal?.throwIfAborted();
      digest.update(content.subarray(offset, offset + 65536));
      await setImmediate(undefined, { signal });
    }
    digest.update('\0');
    files.push({ path, content });
  }
  const assetsDigest = digest.digest('hex');
  if (
    digestWorkflowValue({
      sourceBinding: current.sourceBinding,
      files: assetsDigest,
      contract: current.contract,
    }) !== entry.descriptor.revision ||
    (
      await revalidateSkillWorkflowAsync(entry, resolveCapability, knowledgeScope, {
        signal,
        compiler,
      })
    ).descriptor.revision !== entry.descriptor.revision
  )
    throw new AgentError('workflow_source_changed');
  signal?.throwIfAborted();
  const root = await realpath(await mkdtemp(join(base, 'kite-compensation-assets-')));
  const identity = directoryIdentity(root);
  const directories = new Set([root]);
  const cleanup = async () => {
    assertDirectory(identity);
    for (const directory of [...directories].reverse()) await chmod(directory, 0o700);
    await rm(root, { recursive: true });
  };
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const parts = file.path.split('/');
      let directory = root;
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        if (!directories.has(directory)) {
          await mkdir(directory, { mode: 0o700 });
          directories.add(directory);
        }
      }
      await writeFile(join(root, file.path), file.content, { flag: 'wx', mode: 0o400, signal });
    }
    for (const directory of [...directories].reverse()) await chmod(directory, 0o500);
    return { root, assetsDigest, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
