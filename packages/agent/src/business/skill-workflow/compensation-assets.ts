import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  type CompiledSkillWorkflow,
  revalidateSkillWorkflow,
  type WorkflowCapability,
} from '../../skills/workflow-contract';
import { readBoundWorkflowFile } from '../../skills/workflow-contract/reference';
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
export function sealCompensationAssets(
  entry: CompiledSkillWorkflow,
  base: string,
  resolveCapability?: (id: string) => WorkflowCapability | undefined,
) {
  const current = revalidateSkillWorkflow(entry, resolveCapability);
  if (
    !current.contract ||
    !current.sourceBinding ||
    current.descriptor.availability !== 'available' ||
    current.descriptor.revision !== entry.descriptor.revision
  )
    throw new AgentError('workflow_source_changed');
  const digest = createHash('sha256');
  const files = current.contract.files.map((path) => {
    if (!path || path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new AgentError('workflow_compensation_path_invalid');
    const target = join(current.sourceBinding!.canonicalRoot, path);
    const content = readBoundWorkflowFile(
      current.sourceBinding!.canonicalRoot,
      target,
      lstatSync(target),
    );
    digest
      .update(path)
      .update('\0')
      .update(String(content.byteLength))
      .update('\0')
      .update(content)
      .update('\0');
    return { path, content };
  });
  const assetsDigest = digest.digest('hex');
  if (
    digestWorkflowValue({
      sourceBinding: current.sourceBinding,
      files: assetsDigest,
      contract: current.contract,
    }) !== entry.descriptor.revision ||
    revalidateSkillWorkflow(entry, resolveCapability).descriptor.revision !==
      entry.descriptor.revision
  )
    throw new AgentError('workflow_source_changed');
  const root = realpathSync.native(mkdtempSync(join(base, 'kite-compensation-assets-')));
  const identity = directoryIdentity(root);
  const directories = new Set([root]);
  const cleanup = () => {
    assertDirectory(identity);
    for (const directory of [...directories].reverse()) chmodSync(directory, 0o700);
    rmSync(root, { recursive: true });
  };
  try {
    for (const file of files) {
      const parts = file.path.split('/');
      let directory = root;
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        if (!directories.has(directory)) {
          mkdirSync(directory, { mode: 0o700 });
          directories.add(directory);
        }
      }
      writeFileSync(join(root, file.path), file.content, { flag: 'wx', mode: 0o400 });
    }
    for (const directory of [...directories].reverse()) chmodSync(directory, 0o500);
    return { root, assetsDigest, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
