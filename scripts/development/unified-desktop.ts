import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { releaseErrorCode } from '../release/release-arguments';
import { selectDevelopmentServiceArtifact } from './unified-cli';

const repositoryRoot = resolve(import.meta.dir, '../..');
const help = `Kite desktop development
  npm run desktop:dev
  npm run desktop:dev -- --help
Uses the built apps/service/dist/main.js and installed Electron.
Development data stays in this checkout's .kite-code/unified-development.
`;

export async function runDevelopmentDesktop(
  input: {
    readonly argv?: readonly string[];
    readonly root?: string;
    readonly executable?: string;
  } = {},
): Promise<number> {
  const argv = input.argv ?? process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(help);
    return 0;
  }
  if (argv.length) throw Error('desktop_development_arguments_invalid');
  const root = input.root ?? repositoryRoot;
  const artifact = selectDevelopmentServiceArtifact(root, input.executable);
  let electron: string;
  try {
    const installed: unknown = createRequire(join(root, 'apps/desktop/package.json'))('electron');
    if (typeof installed !== 'string') throw Error('development_electron_asset_unavailable');
    electron = realpathSync(installed);
    if (!lstatSync(electron).isFile()) throw Error('development_electron_asset_unavailable');
  } catch {
    throw Error('development_electron_asset_unavailable');
  }
  const { buildNativeDesktop } = await import('../../apps/desktop/scripts/build-native');
  const cache = join(root, '.cache');
  mkdirSync(cache, { recursive: true });
  const outdir = mkdtempSync(join(cache, 'unified-desktop-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let requested: 'SIGINT' | 'SIGTERM' | undefined;
  const terminate = (signal: 'SIGINT' | 'SIGTERM') => {
    requested = signal;
    if (child && child.exitCode === null) {
      child.kill(signal);
    }
  };
  const interrupt = () => terminate('SIGINT');
  const stop = () => terminate('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', stop);
  try {
    await buildNativeDesktop(
      {
        kind: 'development',
        serviceEntrypoint: artifact.entrypoint,
        serviceSha256: artifact.entrypointSha256,
        bunExecutable: artifact.executable,
        bunSha256: artifact.executableSha256,
        buildId: artifact.buildId,
        apiMajor: artifact.apiMajor,
        requiredCapabilities: ['file_recovery'],
        profile: {
          dataRoot: join(root, '.kite-code', 'unified-development'),
          profile: 'development',
        },
      },
      outdir,
    );
    if (requested) return requested === 'SIGINT' ? 130 : 143;
    const env = { ...process.env };
    for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
      delete env[name];
    child = Bun.spawn([electron, outdir], {
      cwd: root,
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', stop);
    rmSync(outdir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runDevelopmentDesktop();
  } catch (error) {
    const code = releaseErrorCode(error, 'desktop_development_failed');
    process.stderr.write(`${code}\n`);
    if (code === 'development_service_asset_unavailable')
      process.stderr.write('Build the local workspaces first: npm run build\n');
    process.exitCode = 1;
  }
}
