import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
export function readBoundWorkflowFile(root: string, target: string, expected: Stats): Buffer {
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
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
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
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
