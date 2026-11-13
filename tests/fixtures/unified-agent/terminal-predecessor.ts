/** Local real-code comparison using reviewed prebuilt historical artifacts. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';
import {
  COMPATIBLE_PREDECESSOR_COMMIT,
  COMPATIBLE_PREDECESSOR_INPUT_PATHS,
  COMPATIBLE_PREDECESSOR_MIGRATIONS,
} from './compatible-predecessor-input';
import { matchReviewedPredecessorInput } from './predecessor-reviewed-input';
import { matchPredecessorShellParserInput } from './predecessor-shell-parser-input';
import { matchPredecessorStdioInput } from './predecessor-stdio-input';
import { refinePredecessorWorkspaceDeclarations } from './predecessor-workspace-declarations';

// Original committed PC UI with current locked inputs and DB7. Earlier comparisons
// used 3140 (macOS) / 1b796 (Linux); their locks predate the PC presentation migration.
// Keep all original-source, dependency, engine and actual-code-change guards below.
export const COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT = COMPATIBLE_PREDECESSOR_COMMIT;
// Historical six-migration witness remains bound to its original SQL bytes.
export const SESSION_FILES_TERMINAL_PREDECESSOR_COMMIT = '12628a616e7614cbd60666d71896b1db9f74b0f5';
export const SESSION_FILES_PREDECESSOR_MIGRATIONS = [
  ...COMPATIBLE_PREDECESSOR_MIGRATIONS,
  {
    path: 'packages/agent/src/storage/migrations/0003-session-reconciliation.sql',
    sha256: '30009dcece4f09ff83c960af333c34e173f9173d728449b72573c2ebd2bac97d',
  },
  {
    path: 'packages/agent/src/storage/migrations/0004-pending-input-order.sql',
    sha256: '8e70509f93e990c6a7b556d8d4fe9d6d6dc358dc165b1a40ddac09f056bee7ce',
  },
  {
    path: 'packages/agent/src/storage/migrations/0005-authorization-check.sql',
    sha256: 'c419d4105a8aa62df8ea05ec78aea48575f66a8bfef14d977f6fabed9f0c12ab',
  },
  {
    path: 'packages/agent/src/storage/migrations/0006-input-file-imports.sql',
    sha256: 'af8e55877fe1000569c35d6828b3f659baf04ad4844f67a451125f6f862fde4c',
  },
] as const;
// Last reviewed clean Bun candidate before the Node migration, using the consolidated Core schema.
export const CURRENT_SCHEMA_TERMINAL_PREDECESSOR_COMMIT =
  'a45ca81cf778b6ab8177424376e48b4134f06255';
export const CURRENT_SCHEMA_PREDECESSOR_MIGRATIONS = [
  {
    path: 'packages/agent/src/storage/migrations/0001-baseline.sql',
    sha256: '31bcc115aa410172806a87ec6ab66c4ac6858f48e9e1b2732f795162f0de3a54',
  },
  {
    path: 'packages/agent/src/storage/migrations/0002-trajectory-facts.sql',
    sha256: '8c14e1d50397aaf3826425f2c6d574ae26dce1d224f912138196710294325612',
  },
] as const;
export const TERMINAL_PREDECESSOR_COMMIT = 'a2b6441fde28d9c0f895a26e6a9d2471d2b1b242';
const baseline = 'packages/agent/src/storage/migrations/0001-baseline.sql';
const baselineSha256 = '92773869c4d4e68947e9721d5bb6d28e10567c6dc3a82b56726b1a0fb7adee42';
const workspaces = [
  'packages/ai',
  'packages/agent',
  'packages/client',
  'packages/ui',
  'apps/service',
  'apps/cli',
  'apps/desktop',
  'apps/web',
] as const;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Project only reviewed workspace declarations; resolved packages stay byte-exact. */
export function withoutReviewedTuiLockDeclarations(current: Uint8Array): Uint8Array | undefined {
  const text = Buffer.from(
    refinePredecessorWorkspaceDeclarations('bun.lock', current)?.bytes ?? current,
  ).toString('utf8');
  const startAnchor = '    "packages/ui": {\n';
  if (text.split(startAnchor).length !== 2) return undefined;
  const start = text.indexOf(startAnchor),
    end = text.indexOf('\n    },\n', start);
  if (end < 0) return undefined;
  const workspace = text.slice(start, end);
  const anchor = '        "ink": "^7.1.1",\n';
  const increment =
    anchor +
    '        "ink-syntax-highlight": "^2.0.2",\n' +
    '        "ink-text-input": "^6.0.0",\n';
  if (workspace.split(increment).length !== 2) return undefined;
  return Buffer.from(text.slice(0, start) + workspace.replace(increment, anchor) + text.slice(end));
}
export function withoutReviewedDesktopDevelopmentScript(
  current: Uint8Array,
): Uint8Array | undefined {
  const text = Buffer.from(current).toString('utf8');
  const startAnchor = '  "scripts": {\n';
  if (text.split(startAnchor).length !== 2) return undefined;
  const start = text.indexOf(startAnchor),
    end = text.indexOf('\n  },\n', start);
  if (end < 0) return undefined;
  const scripts = text.slice(start, end);
  const increment = '    "desktop:dev": "bun run scripts/development/unified-desktop.ts",\n';
  if (scripts.split(increment).length !== 2) return undefined;
  return Buffer.from(text.slice(0, start) + scripts.replace(increment, '') + text.slice(end));
}

/** Verify exact source and dependency increments; never rewrite predecessor manifests or locks. */
export function matchTerminalPredecessorInput(
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
):
  | 'identical'
  | 'process_observation_source_entry'
  | 'windows_native_bootstrap_source_entry'
  | 'runtime_stdio_validation_script_increment'
  | 'shell_parser_locked_dependency_increment'
  | 'process_observation_and_shell_parser_increment'
  | 'shell_parser_and_tui_workspace_dependency_increment'
  | 'tui_workspace_dependency_increment'
  | 'runtime_stdio_and_desktop_development_script_increment'
  | 'reviewed_locked_input_increment'
  | undefined {
  if (!COMPATIBLE_PREDECESSOR_INPUT_PATHS.some((input) => input === path)) return undefined;
  const oldBytes = Buffer.from(previous),
    actualBytes = Buffer.from(current);
  if (oldBytes.equals(actualBytes)) return 'identical';
  const reviewed = matchReviewedPredecessorInput('terminal_legacy', path, previous, current);
  if (reviewed) return reviewed.match;
  const currentBytes = Buffer.from(
    refinePredecessorWorkspaceDeclarations(path, current)?.bytes ?? current,
  );
  if (path === 'bun.lock') {
    const originalMatch = matchPredecessorShellParserInput(path, previous, currentBytes);
    if (originalMatch) return originalMatch;
    const reviewed = withoutReviewedTuiLockDeclarations(currentBytes);
    return reviewed && matchPredecessorShellParserInput(path, previous, reviewed)
      ? 'shell_parser_and_tui_workspace_dependency_increment'
      : undefined;
  }
  if (path === 'package.json') {
    const originalMatch = matchPredecessorStdioInput(path, previous, current);
    if (originalMatch) return originalMatch;
    const reviewed = withoutReviewedDesktopDevelopmentScript(current);
    return reviewed && matchPredecessorStdioInput(path, previous, reviewed)
      ? 'runtime_stdio_and_desktop_development_script_increment'
      : undefined;
  }
  if (path === 'packages/ui/package.json') {
    const original = oldBytes.toString('utf8');
    const anchor = '    "tailwind-merge": "3.6.0"\n';
    if (original.split(anchor).length !== 2) return undefined;
    const expected = original.replace(
      anchor,
      '    "tailwind-merge": "3.6.0",\n' +
        '    "ink-syntax-highlight": "^2.0.2",\n' +
        '    "ink-text-input": "^6.0.0"\n',
    );
    return Buffer.from(expected).equals(currentBytes)
      ? 'tui_workspace_dependency_increment'
      : undefined;
  }
  if (path === 'apps/service/package.json') {
    const original = oldBytes.toString('utf8'),
      exportAnchor = '    "./native-runtime-assets": "./src/native-runtime-assets.ts",\n',
      buildAnchor = ' ./src/native-runtime-assets.ts ./src/runtime-protection.ts ';
    if (
      original.includes('windows-native-bootstrap') ||
      original.split(exportAnchor).length !== 2 ||
      original.split(buildAnchor).length !== 2
    )
      return undefined;
    // 21eb43d8 added exactly this export/build pair; dependency and other bytes stay exact.
    const expected = original
      .replace(
        exportAnchor,
        `${exportAnchor}    "./windows-native-bootstrap": "./src/windows-native-bootstrap.ts",\n`,
      )
      .replace(
        buildAnchor,
        ' ./src/native-runtime-assets.ts ./src/windows-native-bootstrap.ts ./src/runtime-protection.ts ',
      );
    if (Buffer.from(expected).equals(currentBytes)) return 'windows_native_bootstrap_source_entry';
    return undefined;
  }
  if (path !== 'packages/agent/package.json') return undefined;
  const original = oldBytes.toString('utf8'),
    exportAnchor = '    "./resources": "./src/resources.ts",\n',
    buildAnchor = ' ./src/resources.ts ./src/jobs/shell.ts ';
  if (
    original.includes('process-observation') ||
    original.split(exportAnchor).length !== 2 ||
    original.split(buildAnchor).length !== 2
  )
    return undefined;
  // e587a2a9 added exactly these export/build bytes. The dedicated matcher below
  // additionally admits only the current Agent permissions entry/parser closure.
  const expected = original
    .replace(
      exportAnchor,
      `${exportAnchor}    "./process-observation": "./src/process-observation.ts",\n`,
    )
    .replace(buildAnchor, ' ./src/resources.ts ./src/process-observation.ts ./src/jobs/shell.ts ');
  if (Buffer.from(expected).equals(currentBytes)) return 'process_observation_source_entry';
  return matchPredecessorShellParserInput(path, Buffer.from(expected), currentBytes)
    ? 'process_observation_and_shell_parser_increment'
    : undefined;
}
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Bound read-only Git input retrieval. */
async function command(argv: string[], cwd: string, timeoutMs: number): Promise<Buffer> {
  return await new Promise((accept, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached,
      env: {
        PATH: process.env.PATH ?? '',
        LANG: 'en_US.UTF-8',
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '',
      bytes = 0,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          if (detached) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error);
        }
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 8 * 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || bytes > 8 * 1024 * 1024)
        reject(
          Error(
            `terminal_predecessor_command_failed:${argv[0]}:${argv[1]}:${code}:signal=${signal ?? 'none'}:timeout=${timedOut}:${stderr}`,
          ),
        );
      else accept(Buffer.concat(stdout));
    });
  });
}

type HistoricalArtifactInput = {
  root: string;
  repositoryRoot: string;
  native?: boolean;
};
const legacyMigrations = [{ path: baseline, sha256: baselineSha256 }] as const;

type PredecessorPolicy = {
  commit: string;
  variablePrefix: string;
  migrations: readonly { path: string; sha256: string }[];
  schemaCapability: 'trajectory-facts-v1' | 'recovery-audit-v1' | 'baseline-v1';
  expectIncompatible?: true;
  inputInventory?: readonly string[];
};

export const RELEASE_PREDECESSORS = {
  currentSchema: {
    commit: CURRENT_SCHEMA_TERMINAL_PREDECESSOR_COMMIT,
    variablePrefix: 'KITE_PREDECESSOR_CURRENT_SCHEMA',
    migrations: CURRENT_SCHEMA_PREDECESSOR_MIGRATIONS,
    schemaCapability: 'trajectory-facts-v1',
    inputInventory: [
      'bun.lock',
      'package.json',
      ...['packages/trajectory', 'packages/trace-extension-sdk', ...workspaces].map(
        (path) => `${path}/package.json`,
      ),
      'patches/ink-virtual-list@0.2.3.patch',
      'patches/@radix-ui%2Freact-scroll-area@1.2.18.patch',
    ],
  },
  legacy: {
    commit: TERMINAL_PREDECESSOR_COMMIT,
    variablePrefix: 'KITE_PREDECESSOR_LEGACY',
    migrations: legacyMigrations,
    schemaCapability: 'baseline-v1',
    expectIncompatible: true,
  },
} satisfies Record<string, PredecessorPolicy>;

function artifactEnvironmentPath(prefix: string, kind: 'TERMINAL' | 'NATIVE') {
  const pathKey = `${prefix}_${kind}`;
  const digestKey = `${pathKey}_SHA256`;
  const root = process.env[pathKey];
  const digest = process.env[digestKey];
  if (!root) throw Error(`predecessor_artifact_required:${pathKey}`);
  if (!digest) throw Error(`predecessor_artifact_required:${digestKey}`);
  if (!isAbsolute(root) || !/^[a-f0-9]{64}$/.test(digest))
    throw Error(`predecessor_artifact_invalid:${pathKey}`);
  return { root, digest };
}

/** Verify caller-reviewed bytes before use; historical source and current lock stay independent. */
export async function verifyPinnedPredecessor(
  input: HistoricalArtifactInput,
  policy: PredecessorPolicy,
) {
  const root = realpathSync(input.root),
    repository = realpathSync(input.repositoryRoot);
  if (inside(repository, root) || inside(root, repository) || !lstatSync(root).isDirectory())
    throw Error('terminal_predecessor_root_invalid');
  if (!policy.expectIncompatible) {
    for (const migration of policy.migrations)
      if (sha256(readFileSync(join(repository, migration.path))) !== migration.sha256)
        throw Error(`predecessor_current_schema_changed:${migration.path}`);
  }
  const terminal = artifactEnvironmentPath(policy.variablePrefix, 'TERMINAL');
  const native = input.native
    ? artifactEnvironmentPath(policy.variablePrefix, 'NATIVE')
    : undefined;
  for (const artifact of [terminal, native]) {
    if (artifact && inside(root, artifact.root))
      throw Error('predecessor_artifact_disposable_root');
  }
  const candidate = verifyTerminalRuntimeBundle(terminal.root);
  const nativeCandidate = native ? verifyNativeRuntimeBundle(native.root) : undefined;
  if (
    candidate.digest !== terminal.digest ||
    (native &&
      (nativeCandidate?.digest !== native.digest ||
        nativeCandidate.terminal.digest !== candidate.digest))
  )
    throw Error('predecessor_artifact_digest_mismatch');
  const { manifest } = candidate;
  if (
    manifest.source.commit !== policy.commit ||
    manifest.source.dirty ||
    manifest.target.platform !== process.platform ||
    manifest.target.arch !== process.arch ||
    manifest.bunVersion === undefined ||
    manifest.nodeVersion !== undefined ||
    manifest.sqlite.driver !== 'bun:sqlite'
  )
    throw Error('predecessor_artifact_provenance_invalid');
  const migrationDirectory = 'node_modules/@kite-ai/agent/storage/migrations/';
  const artifactMigrations = manifest.files.filter((file) =>
    file.path.startsWith(migrationDirectory),
  );
  if (
    artifactMigrations.length !== policy.migrations.length ||
    policy.migrations.some(
      (migration) =>
        !artifactMigrations.some(
          (file) =>
            file.path === `${migrationDirectory}${basename(migration.path)}` &&
            file.sha256 === migration.sha256,
        ),
    )
  )
    throw Error('predecessor_artifact_schema_invalid');

  const historical = (path: string) =>
    command(['git', 'show', `${policy.commit}:${path}`], repository, 10000);
  const historicalManifest = JSON.parse((await historical('package.json')).toString()) as {
    version: string;
    workspaces: string[];
    patchedDependencies?: Record<string, string>;
  };
  if (manifest.productVersion !== historicalManifest.version)
    throw Error('predecessor_artifact_product_version_mismatch');
  const patches = Object.values(historicalManifest.patchedDependencies ?? {});
  if (patches.some((path) => !/^patches\/(?:[a-zA-Z0-9@._+-]|%2F)+\.patch$/.test(path)))
    throw Error('predecessor_artifact_patch_path_invalid');
  const paths = [
    'bun.lock',
    'package.json',
    ...historicalManifest.workspaces.map((path) => `${path}/package.json`),
    ...patches,
  ];
  if (policy.inputInventory && JSON.stringify(paths) !== JSON.stringify(policy.inputInventory))
    throw Error('predecessor_historical_input_inventory_changed');
  for (const migration of policy.migrations)
    if (sha256(await historical(migration.path)) !== migration.sha256)
      throw Error(`predecessor_historical_schema_changed:${migration.path}`);
  const historicalSourceInputs = await Promise.all(
    paths.map(async (path) => ({ path, sha256: sha256(await historical(path)) })),
  );
  return {
    candidate,
    nativeCandidate,
    provenance: {
      kind: 'local-real-code-comparison' as const,
      historicalInput: 'prebuilt' as const,
      platform: process.platform,
      commit: policy.commit,
      dirty: false as const,
      productVersion: manifest.productVersion,
      terminalDigest: candidate.digest,
      ...(nativeCandidate ? { nativeDigest: nativeCandidate.digest } : {}),
      historicalSourceInputs,
      baseline: {
        path: baseline,
        sha256: policy.migrations.find((migration) => migration.path === baseline)!.sha256,
        format: 1 as const,
      },
      schemaCapability: policy.schemaCapability,
      migrations: policy.migrations,
    },
  };
}
export function materializeTerminalPredecessor(input: HistoricalArtifactInput) {
  return verifyPinnedPredecessor(input, RELEASE_PREDECESSORS.legacy);
}
export function materializeCompatibleTerminalPredecessor(input: HistoricalArtifactInput) {
  return verifyPinnedPredecessor(input, {
    commit: COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT,
    variablePrefix: 'KITE_PREDECESSOR_COMPATIBLE',
    migrations: COMPATIBLE_PREDECESSOR_MIGRATIONS,
    schemaCapability: 'recovery-audit-v1',
    inputInventory: COMPATIBLE_PREDECESSOR_INPUT_PATHS,
  });
}
export function materializeCurrentSchemaTerminalPredecessor(input: HistoricalArtifactInput) {
  return verifyPinnedPredecessor(input, RELEASE_PREDECESSORS.currentSchema);
}
