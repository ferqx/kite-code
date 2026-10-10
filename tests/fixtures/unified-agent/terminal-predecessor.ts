/** Local real-code comparison only; this is not published-predecessor release qualification. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';

// Original committed PC UI with current locked inputs and DB7. Earlier comparisons
// used 3140 (macOS) / 1b796 (Linux); their locks predate the PC presentation migration.
// Keep all original-source, dependency, engine and actual-code-change guards below.
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

/** Verify the one source entry added after this predecessor; never rewrite its manifest. */
export function matchTerminalPredecessorInput(
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
): 'identical' | 'process_observation_source_entry' | undefined {
  const oldBytes = Buffer.from(previous),
    currentBytes = Buffer.from(current);
  if (oldBytes.equals(currentBytes)) return 'identical';
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
  // e587a2a9 added exactly these export/build bytes. All dependency declarations,
  // other source entries, metadata and formatting must still be byte-identical.
  const expected = original
    .replace(
      exportAnchor,
      `${exportAnchor}    "./process-observation": "./src/process-observation.ts",\n`,
    )
    .replace(buildAnchor, ' ./src/resources.ts ./src/process-observation.ts ./src/jobs/shell.ts ');
  return Buffer.from(expected).equals(currentBytes)
    ? 'process_observation_source_entry'
    : undefined;
}
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Each command owns its process group, including the old builder's compiler children. */
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
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || bytes > 8 * 1024 * 1024)
        reject(
          Error(
            `terminal_predecessor_command_failed:${argv[0]}:${argv[1]}:${code}:timeout=${timedOut}:${stderr}`,
          ),
        );
      else accept(Buffer.concat(stdout));
    });
  });
}

/**
 * Caller supplies an empty, owned temporary directory and remains its sole cleanup owner.
 * Failure retains the clone and command scripts for diagnosis; success removes all old source.
 * No install, checkout, build, or source mutation occurs in repositoryRoot.
 */
export async function materializeTerminalPredecessor(input: {
  root: string;
  repositoryRoot: string;
  bunExecutable?: string;
  sqliteLibrary?: string;
  buildTimeoutMs?: number;
  /** Also build the old Native app from this same original checkout, before deleting it. */
  nativeElectronDist?: string;
}) {
  const root = realpathSync(input.root),
    repository = realpathSync(input.repositoryRoot);
  if (inside(repository, root) || inside(root, repository) || !lstatSync(root).isDirectory())
    throw Error('terminal_predecessor_root_invalid');
  const source = join(root, 'predecessor-source'),
    candidate = join(root, 'predecessor-candidate');
  const mirrorScript = join(root, 'predecessor-dependencies.mjs');
  const buildScript = join(root, 'predecessor-build.ts');
  if ([source, candidate, mirrorScript, buildScript].some(existsSync))
    throw Error('terminal_predecessor_destination_exists');
  const bun = realpathSync(input.bunExecutable ?? process.execPath);
  const timeoutMs = input.buildTimeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw Error('terminal_predecessor_deadline_invalid');
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
    patchedDependencies?: Record<string, string>;
  };
  const inputs = [
    'bun.lock',
    'package.json',
    ...workspaces.map((path) => `${path}/package.json`),
    ...Object.values(manifest.patchedDependencies ?? {}),
  ];
  const lockedInputs: {
    path: string;
    sha256: string;
    currentSha256: string;
    match: 'identical' | 'process_observation_source_entry';
  }[] = [];
  for (const path of inputs) {
    if (!inside(repository, resolve(repository, path)))
      throw Error('terminal_predecessor_input_escape');
    const old = await command(
      ['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${path}`],
      repository,
      10_000,
    );
    const current = readFileSync(join(repository, path)),
      match = matchTerminalPredecessorInput(path, old, current);
    if (!match) throw Error(`terminal_predecessor_dependency_input_changed:${path}`);
    lockedInputs.push({ path, sha256: sha256(old), currentSha256: sha256(current), match });
  }
  const oldBaseline = await command(
    ['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${baseline}`],
    repository,
    10_000,
  );
  if (
    sha256(oldBaseline) !== baselineSha256 ||
    sha256(readFileSync(join(repository, baseline))) !== baselineSha256
  )
    throw Error('terminal_predecessor_baseline_changed');
  await command(
    ['git', 'clone', '--shared', '--no-checkout', '--', repository, source],
    root,
    30_000,
  );
  await command(['git', 'checkout', '--detach', TERMINAL_PREDECESSOR_COMMIT], source, 30_000);
  // The old builder rejects npm realpaths outside its own node_modules. Mirror exact installed
  // bytes and internal links, remap package-local npm links, and omit current workspace links
  // before adding the eight old owners. The old builder still verifies the resulting closure.
  writeFileSync(
    mirrorScript,
    `
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, rmSync, symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const [installed, target, source, workspaceJSON, repository] = process.argv.slice(2);
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
};
cpSync(installed, target, {
  recursive: true,
  verbatimSymlinks: true,
  filter: path => {
    if (relative(installed, path).split(sep).includes('@kite-ai')) return false;
    if (!lstatSync(path).isSymbolicLink()) return true;
    // Installed history may retain renamed workspace scopes. Determine their targets
    // without following the link during traversal; no current repository source is copied.
    const declared = resolve(dirname(path), readlinkSync(path));
    const resolved = existsSync(path) ? realpathSync(path) : declared;
    return !(inside(repository, resolved) && !inside(installed, resolved));
  },
});
function walk(folder) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name), stat = lstatSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.isSymbolicLink()) {
      const link = readlinkSync(path);
      const original = resolve(dirname(join(installed, relative(target, path))), link);
      if (!inside(installed, original))
        throw Error('terminal_predecessor_dependency_link_escape:' + path);
      if (isAbsolute(link)) {
        rmSync(path);
        symlinkSync(relative(dirname(path), join(target, relative(installed, original))), path);
      }
      if (existsSync(path) && !inside(target, realpathSync(path)))
        throw Error('terminal_predecessor_dependency_realpath_escape:' + path);
    }
  }
}
walk(target);
function mirrorLocal(installedFolder, oldFolder) {
  mkdirSync(oldFolder, { recursive: true });
  for (const name of readdirSync(installedFolder)) {
    const path = join(installedFolder, name), oldPath = join(oldFolder, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const declared = resolve(dirname(path), readlinkSync(path));
      const resolved = existsSync(path) ? realpathSync(path) : declared;
      if (inside(repository, resolved) && !inside(installed, resolved)) continue;
      if (!inside(installed, resolved))
        throw Error('terminal_predecessor_local_dependency_escape:' + path);
      const mapped = join(target, relative(installed, resolved));
      if (!existsSync(mapped) || !inside(target, realpathSync(mapped)))
        throw Error('terminal_predecessor_local_dependency_missing:' + path);
      symlinkSync(relative(dirname(oldPath), mapped), oldPath, lstatSync(mapped).isDirectory() ? 'dir' : 'file');
    } else if (stat.isDirectory()) {
      if (existsSync(join(path, 'package.json')))
        throw Error('terminal_predecessor_local_dependency_not_link:' + path);
      mirrorLocal(path, oldPath);
    } else throw Error('terminal_predecessor_local_dependency_not_link:' + path);
  }
}
for (const path of JSON.parse(workspaceJSON)) {
  const local = join(repository, path, 'node_modules');
  if (existsSync(local)) mirrorLocal(local, join(source, path, 'node_modules'));
}
for (const path of JSON.parse(workspaceJSON)) {
  const pkg = JSON.parse(readFileSync(join(source, path, 'package.json'), 'utf8'));
  const link = join(target, pkg.name);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(dirname(link), join(source, path)), link, 'dir');
  if (realpathSync(link) !== realpathSync(join(source, path)))
    throw Error('terminal_predecessor_workspace_resolution_mismatch');
}
`,
  );
  await command(
    [
      bun,
      mirrorScript,
      realpathSync(join(repository, 'node_modules')),
      join(source, 'node_modules'),
      source,
      JSON.stringify(workspaces),
      repository,
    ],
    root,
    timeoutMs,
  );
  const sourceIdentity = async () => ({
    commit: (await command(['git', 'rev-parse', 'HEAD'], source, 10_000)).toString().trim(),
    dirty: (await command(['git', 'status', '--porcelain'], source, 10_000)).length !== 0,
  });
  const before = await sourceIdentity();
  if (before.commit !== TERMINAL_PREDECESSOR_COMMIT || before.dirty)
    throw Error('terminal_predecessor_source_identity_invalid');
  writeFileSync(
    buildScript,
    `import {buildTerminalBundle} from ${JSON.stringify(pathToFileURL(join(source, 'scripts/release/terminal-bundle.ts')).href)};\nawait buildTerminalBundle(${JSON.stringify({ destination: candidate, repositoryRoot: source, bunExecutable: bun, ...(input.sqliteLibrary ? { sqliteLibrary: input.sqliteLibrary } : {}) })});\n` +
      (input.nativeElectronDist
        ? `import {buildNativeCandidate} from ${JSON.stringify(pathToFileURL(join(source, 'apps/desktop/scripts/build-native.ts')).href)};\nawait buildNativeCandidate(${JSON.stringify({ terminalRoot: candidate, electronDist: realpathSync(input.nativeElectronDist), outdir: join(root, 'predecessor-native') })});\n`
        : ''),
  );
  await command([bun, buildScript], source, timeoutMs);
  const built = verifyTerminalRuntimeBundle(candidate),
    after = await sourceIdentity();
  const oldProductVersion = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  if (
    built.manifest.source.commit !== TERMINAL_PREDECESSOR_COMMIT ||
    built.manifest.source.dirty ||
    after.dirty ||
    after.commit !== before.commit ||
    built.manifest.productVersion !== oldProductVersion
  )
    throw Error('terminal_predecessor_candidate_provenance_invalid');
  rmSync(source, { recursive: true });
  rmSync(mirrorScript);
  rmSync(buildScript);
  if (existsSync(source)) throw Error('terminal_predecessor_source_removal_unconfirmed');
  const verified = verifyTerminalRuntimeBundle(candidate);
  if (verified.digest !== built.digest) throw Error('terminal_predecessor_candidate_changed');
  const nativeCandidate = input.nativeElectronDist
    ? verifyNativeRuntimeBundle(join(root, 'predecessor-native'))
    : undefined;
  if (nativeCandidate && nativeCandidate.terminal.digest !== verified.digest)
    throw Error('native_predecessor_terminal_mismatch');
  return {
    candidate: verified,
    ...(nativeCandidate ? { nativeCandidate } : {}),
    provenance: {
      kind: 'local-real-code-comparison' as const,
      platform: process.platform,
      commit: TERMINAL_PREDECESSOR_COMMIT,
      dirty: false as const,
      builder: 'scripts/release/terminal-bundle.ts',
      productVersion: oldProductVersion as string,
      lockedInputs,
      baseline: { path: baseline, sha256: baselineSha256, format: 1 as const },
      sourceRoot: source,
      sourceRemoved: true as const,
    },
  };
}
