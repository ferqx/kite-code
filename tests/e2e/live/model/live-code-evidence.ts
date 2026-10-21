import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Local code provenance only. Never includes configuration, identities, or file bodies. */
export function liveCodeEvidence() {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const paths = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\0')
        .filter((path) => path && !path.endsWith('.md')),
    ),
  ].sort();
  const digest = createHash('sha256');
  for (const path of paths) {
    const absolute = join(root, path);
    digest.update(`${path}\0`);
    try {
      const stat = lstatSync(absolute);
      digest.update(`${stat.mode}\0`);
      digest.update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute));
      digest.update('\0');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      digest.update('deleted\0');
    }
  }
  return { head, nonMarkdownFiles: paths.length, workingTreeSha256: digest.digest('hex') };
}
