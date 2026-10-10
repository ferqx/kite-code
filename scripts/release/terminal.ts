import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateDirectory } from '../../packages/agent/src/platform/windows-path-security';
import { packTerminalBundle, unpackTerminalBundle } from './terminal-archive';
import {
  buildTerminalBundle,
  installTerminalBundle,
  rollbackTerminalBundle,
  uninstallTerminalBundle,
  verifyTerminalBundle,
} from './terminal-bundle';

const options = {
  build: ['directory'],
  pack: ['directory', 'archive'],
  unpack: ['archive', 'sha256', 'directory'],
  verify: ['directory'],
  install: ['archive', 'sha256', 'prefix'],
  rollback: ['prefix'],
  uninstall: ['prefix'],
} as const;
const help = `Terminal candidate tooling (native platform only)
  build --directory <new-directory> [--sqlite-library <reviewed-macOS-library>]
  pack --directory <bundle> --archive <new-tar.gz>
  unpack --archive <tar.gz> --sha256 <expected-sha256> --directory <new-directory>
  verify --directory <bundle>
  install --archive <tar.gz> --sha256 <expected-sha256> --prefix <managed-directory>
  rollback --prefix <managed-directory>
  uninstall --prefix <managed-directory>
Checksums establish integrity, not publisher authenticity. Installation does not stop services.
`;

export async function runTerminalRelease(args: string[]): Promise<unknown> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help };
  const command = args[0];
  if (!command || !Object.hasOwn(options, command)) throw Error('terminal_arguments_invalid');
  const required = options[command as keyof typeof options] as readonly string[];
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]!,
      key = flag.slice(2),
      value = args[index + 1];
    if (
      !flag.startsWith('--') ||
      (!required.includes(key) && !(command === 'build' && key === 'sqlite-library')) ||
      values.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw Error('terminal_arguments_invalid');
    values.set(key, value);
  }
  if (required.some((key) => !values.has(key))) throw Error('terminal_arguments_invalid');
  const value = (key: string) => values.get(key)!;
  switch (command) {
    case 'build': {
      const bundle = await buildTerminalBundle({
        destination: value('directory'),
        ...(values.has('sqlite-library') ? { sqliteLibrary: value('sqlite-library') } : {}),
      });
      return { root: bundle.root, candidateId: bundle.candidateId };
    }
    case 'pack':
      return packTerminalBundle({ bundleRoot: value('directory'), archivePath: value('archive') });
    case 'unpack': {
      const bundle = unpackTerminalBundle({
        archivePath: value('archive'),
        sha256: value('sha256'),
        destination: value('directory'),
      });
      return { root: bundle.root, candidateId: bundle.candidateId };
    }
    case 'verify': {
      const bundle = verifyTerminalBundle(value('directory'));
      return { root: bundle.root, candidateId: bundle.candidateId, manifest: bundle.manifest };
    }
    case 'install': {
      const scratch =
        process.platform === 'win32'
          ? join(realpathSync(tmpdir()), `kite-terminal-unpack-${randomUUID()}`)
          : realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-unpack-')));
      if (process.platform === 'win32') privateDirectory(scratch);
      try {
        const bundle = unpackTerminalBundle({
          archivePath: value('archive'),
          sha256: value('sha256'),
          destination: join(scratch, 'candidate'),
        });
        return installTerminalBundle({ bundleRoot: bundle.root, prefix: value('prefix') });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    case 'rollback':
      return rollbackTerminalBundle(value('prefix'));
    case 'uninstall':
      uninstallTerminalBundle(value('prefix'));
      return { removed: value('prefix') };
    default:
      throw Error('terminal_arguments_invalid');
  }
}

if (import.meta.main) {
  try {
    const result = await runTerminalRelease(process.argv.slice(2));
    if (result && typeof result === 'object' && 'help' in result) console.log(result.help);
    else console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'terminal_release_failed');
    process.exitCode = 1;
  }
}
