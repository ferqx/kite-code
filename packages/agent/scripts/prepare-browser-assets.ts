import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { agentBrowserExecutableName, agentBrowserVersion } from '../src/tools/browser/assets';

/** Build a private executable copy of the exact locked dependency for source hosts. */
export function prepareDevelopmentBrowserAssets(agentRoot: string): void {
  if (process.platform === 'win32') return;
  const executable = agentBrowserExecutableName();
  if (!executable) return;
  const require = createRequire(join(agentRoot, 'package.json'));
  const source = dirname(realpathSync(require.resolve('agent-browser/package.json')));
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (manifest.name !== 'agent-browser' || manifest.version !== agentBrowserVersion)
    throw Error('development_browser_dependency_changed');
  const destination = join(agentRoot, 'dist/assets/agent-browser');
  for (const [name, mode] of [
    ['package.json', 0o644],
    ['LICENSE', 0o644],
    [`bin/${executable}`, 0o755],
  ] as const) {
    const input = join(source, name);
    if (!lstatSync(input).isFile() || realpathSync(input) !== input)
      throw Error('development_browser_dependency_invalid');
    const output = join(destination, name);
    const directory = dirname(output);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw Error('development_browser_output_linked');
    const bytes = readFileSync(input);
    const existing = lstatSync(output, { throwIfNoEntry: false });
    if (
      existing?.isFile() &&
      existing.nlink === 1 &&
      (existing.mode & 0o777) === mode &&
      existing.size === bytes.length &&
      readFileSync(output).equals(bytes)
    )
      continue;
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode });
      chmodSync(temporary, mode);
      renameSync(temporary, output);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
