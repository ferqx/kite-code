import { constants, fstatSync, lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import {
  createKnowledgeReadScope,
  type KnowledgeFileAccess,
  type KnowledgeReadScope,
} from '../../platform/knowledge-reads';
export function readBoundWorkflowFile(
  root: string,
  target: string,
  expected: Stats,
  knowledge?: KnowledgeReadScope | KnowledgeFileAccess,
): Buffer {
  const read = (files: KnowledgeFileAccess) => {
    const scope = relative(root, target);
    if (scope === '' || isAbsolute(scope) || scope === '..' || scope.startsWith(`..${sep}`))
      throw Error('Workflow file escapes source root.');
    const directories: Array<{ path: string; stat: Stats }> = [];
    let directory = dirname(target);
    while (true) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Skill reference directories must be non-symlink directories.');
      }
      directories.push({ path: directory, stat });
      if (directory === root) break;
      directory = dirname(directory);
    }
    const canonicalRoot = realpathSync(root);
    const assertBindings = () => {
      for (const binding of directories) {
        const current = lstatSync(binding.path);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== binding.stat.dev ||
          current.ino !== binding.stat.ino
        ) {
          throw new Error('Skill reference directory changed while reading.');
        }
      }
      const canonical = realpathSync(target);
      const rel = relative(canonicalRoot, canonical);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error('Skill reference path escapes its Skill directory.');
      }
    };
    return files.readSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      (descriptor) => {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || !sameReferenceIdentity(expected, opened)) {
          throw new Error('Skill reference file changed while opening.');
        }
        assertBindings();
        if (!sameReferenceIdentity(opened, lstatSync(target))) {
          throw new Error('Skill reference path changed while opening.');
        }
        const content = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (
          !sameReferenceIdentity(opened, after) ||
          content.byteLength !== after.size ||
          !sameReferenceIdentity(after, lstatSync(target))
        ) {
          throw new Error('Skill reference file changed while reading.');
        }
        assertBindings();
        return content;
      },
    );
  };
  const owner = knowledge ?? createKnowledgeReadScope();
  return 'runSync' in owner ? owner.runSync(read) : read(owner);
}

function sameReferenceIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
