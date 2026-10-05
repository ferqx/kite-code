import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLIHostError, type CLIServiceArtifact, parseCLIServiceArtifact } from '@kite-ai/cli/host';
import { runCLIProcess } from '@kite-ai/cli/main';
import { parseCLIArguments } from '../../apps/cli/src/arguments';

const repositoryRoot = resolve(import.meta.dir, '../..');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface DevelopmentCLISelection {
  readonly argv: readonly string[];
  readonly dataRoot: string;
  readonly profile: 'development';
  readonly artifact?: Readonly<CLIServiceArtifact>;
  readonly resolveArtifact?: () => Readonly<CLIServiceArtifact>;
}

/** Validate argv before selecting exact built assets; never read another profile or source fallback. */
export function selectDevelopmentCLI(
  argv: readonly string[],
  root = repositoryRoot,
  executable = process.execPath,
): DevelopmentCLISelection {
  const args = parseCLIArguments(argv);
  const selected = {
    argv: Object.freeze([...argv]),
    dataRoot: join(root, '.kite-code', 'unified-development'),
    profile: 'development' as const,
  };
  if (args.kind === 'server' && ['start', 'restart'].includes(args.action)) {
    return Object.freeze({
      ...selected,
      resolveArtifact: () => selectDevelopmentDaemonArtifact(root, executable),
    });
  }
  if (
    args.kind === 'work' ||
    args.kind === 'caller' ||
    args.kind === 'recovery' ||
    args.kind === 'files'
  ) {
    return Object.freeze(
      args.server
        ? selected
        : {
            ...selected,
            resolveArtifact: () => selectDevelopmentServiceArtifact(root, executable),
          },
    );
  }
  if (
    (args.kind === 'run' ||
      args.kind === 'resume' ||
      args.kind === 'session' ||
      args.kind === 'context' ||
      args.kind === 'job') &&
    args.server
  )
    return Object.freeze(selected);
  if (!['run', 'resume', 'session', 'context', 'job'].includes(args.kind))
    return Object.freeze(selected);
  return Object.freeze({
    ...selected,
    artifact: selectDevelopmentServiceArtifact(root, executable),
  });
}

/** Shared exact development Service bytes for the CLI and terminal host. */
export function selectDevelopmentServiceArtifact(
  root = repositoryRoot,
  executable = process.execPath,
): Readonly<CLIServiceArtifact> {
  const entrypoint = join(root, 'apps/service/dist/main.js');
  try {
    const stat = lstatSync(entrypoint);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new CLIHostError('development_service_asset_unavailable');
    const entrypointSha256 = hash(readFileSync(entrypoint));
    const actualExecutable = realpathSync(executable);
    const artifact = parseCLIServiceArtifact({
      entrypoint,
      entrypointSha256,
      executable: actualExecutable,
      executableSha256: hash(readFileSync(actualExecutable)),
      // This qualifies the exact development entry bytes, not a complete installed release.
      buildId: `development-${entrypointSha256}`,
      apiMajor: 1,
    });
    return artifact;
  } catch (error) {
    if (error instanceof CLIHostError) throw error;
    throw new CLIHostError('development_service_asset_unavailable');
  }
}

/** Only actual daemon launch/preflight resolves this trusted host selection. */
export function selectDevelopmentDaemonArtifact(
  root = repositoryRoot,
  executable = process.execPath,
): Readonly<CLIServiceArtifact> {
  const paired = selectDevelopmentServiceArtifact(root, executable);
  const entrypoint = join(root, 'apps/service/dist/daemon-main.js');
  const directory = join(root, 'apps/web/dist');
  const manifest = join(directory, 'manifest.json');
  try {
    for (const path of [entrypoint, manifest]) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
        throw new CLIHostError('development_daemon_asset_unavailable');
    }
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      realpathSync(directory) !== directory
    )
      throw new CLIHostError('development_daemon_asset_unavailable');
    const entryBytes = readFileSync(entrypoint),
      manifestBytes = readFileSync(manifest);
    const entrypointSha256 = hash(entryBytes),
      manifestSha256 = hash(manifestBytes);
    const buildId =
      'development-daemon-' +
      hash(
        Buffer.from(
          JSON.stringify([
            'kite-development-daemon-v1',
            paired.entrypointSha256,
            entrypointSha256,
            manifestSha256,
          ]),
        ),
      );
    return parseCLIServiceArtifact({
      ...paired,
      buildId,
      daemon: { entrypoint, entrypointSha256, web: { directory, manifestSha256 } },
    });
  } catch (error) {
    if (error instanceof CLIHostError) throw error;
    throw new CLIHostError('development_daemon_asset_unavailable');
  }
}

export function runDevelopmentCLI(
  input: {
    readonly argv?: readonly string[];
    readonly root?: string;
    readonly executable?: string;
  } = {},
): Promise<number> {
  const selected = selectDevelopmentCLI(
    input.argv ?? process.argv.slice(2),
    input.root,
    input.executable,
  );
  return runCLIProcess(selected);
}

if (import.meta.main) {
  try {
    process.exitCode = await runDevelopmentCLI();
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : 'cli_development_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
