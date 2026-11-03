import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A fresh output prevents removed entrypoints and old split chunks from being packaged.
const packageRoot = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
const output = join(packageRoot, 'dist');
// Candidate builders replace the literal output argument with their own fresh
// package directory. Never delete the source dist or an external caller's path
// while building such an already-empty candidate.
const selected = resolve(process.argv[2] ?? 'dist');
if (
  (process.platform === 'win32' ? selected.toLowerCase() : selected) !==
  (process.platform === 'win32' ? output.toLowerCase() : output)
)
  process.exit(0);
function checkDirectory(path: string) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw Error('agent_build_output_is_not_a_directory');
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error('agent_build_output_contains_a_link');
    if (entry.isDirectory()) checkDirectory(join(path, entry.name));
  }
}
if (lstatSync(output, { throwIfNoEntry: false })) {
  checkDirectory(output);
  rmSync(output, { recursive: true });
}
