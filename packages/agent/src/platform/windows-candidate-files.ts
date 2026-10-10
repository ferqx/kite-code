import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { retainWindowsArtifactObjects, type WindowsArtifactScope } from './windows-artifact-scope';

/** Explicit verified-manifest file pin. Import does not open files or load native DLLs. */
export function retainWindowsCandidateFiles(
  root: string,
  relativeFiles: readonly string[],
): WindowsArtifactScope {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('artifact_scope_platform_unsupported');
  if (!isAbsolute(root) || realpathSync.native(root) !== root || !Array.isArray(relativeFiles))
    throw Error('artifact_scope_denied');
  const files: string[] = [];
  const seen = new Set<string>();
  for (const file of relativeFiles) {
    if (
      typeof file !== 'string' ||
      !file ||
      file.length > 32760 ||
      /[\\:]/u.test(file) ||
      Array.from(file).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      file.startsWith('/') ||
      file
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[. ]$/u.test(part) ||
            /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
        )
    )
      throw Error('artifact_scope_denied');
    const key = file.toLowerCase();
    if (seen.has(key)) throw Error('artifact_scope_denied');
    seen.add(key);
    const path = join(root, ...file.split('/'));
    if (realpathSync.native(path) !== path) throw Error('artifact_scope_denied');
    files.push(file);
  }
  return retainWindowsArtifactObjects(root, Object.freeze(files));
}
