import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { agentBrowserExecutableName } from '../../packages/agent/src/tools/browser/assets';
import {
  type BunLockPackage,
  type BunPackageMetadata,
  bunDependencyKey,
  bunDependencySections,
  bunLockfile,
  parseBunLock,
} from './bun-lock';

export interface TerminalWorkspacePackage {
  name: string;
  source: string;
  destination: string;
  /** Trusted build declaration: these ordinary dependencies are already in the generated exports. */
  bundledDependencies?: readonly string[];
}
export interface TerminalDependencyCopy {
  packages: { name: string; version: string; source: string; destination: string }[];
  /** Both path and target are relative: path to destination, target to the link parent. */
  links: { path: string; target: string }[];
}
type Manifest = {
  name: string;
  version: string;
  workspaces?: string[];
  patchedDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  bin?: string | Record<string, string>;
};
type Node = {
  source: string;
  destination: string;
  manifest: Manifest;
  bytes: Buffer;
  edges: Map<string, Node>;
  bundledDependencies?: ReadonlySet<string>;
};
const packageName = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/;
function validPackageName(name: string) {
  return packageName.test(name) && name.split('/').every((part) => part !== '.' && part !== '..');
}
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
function fail(code: string, dependency?: { name: string; source: string }): never {
  throw new Error(`terminal_dependency_${code}`, { cause: dependency });
}
function readManifest(source: string) {
  const manifestPath = realpathSync(join(source, 'package.json'));
  if (!inside(source, manifestPath)) fail('manifest_escape');
  const bytes = readFileSync(manifestPath);
  let value: Manifest;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('manifest_invalid');
  }
  if (
    !value ||
    typeof value.name !== 'string' ||
    !validPackageName(value.name) ||
    typeof value.version !== 'string' ||
    !value.version
  )
    fail('manifest_invalid');
  return { manifest: value, bytes };
}
function accepted(values: string[] | undefined, actual: string) {
  if (values === undefined) return true;
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) fail('manifest_invalid');
  if (values.includes(`!${actual}`)) return false;
  const positive = values.filter((v) => !v.startsWith('!'));
  return positive.length === 0 || positive.includes(actual) || positive.includes('any');
}
function compatible(manifest: Manifest, libc: string) {
  if (
    process.platform === 'linux' &&
    manifest.libc &&
    libc === 'unknown' &&
    accepted(manifest.os, process.platform) &&
    accepted(manifest.cpu, process.arch)
  )
    fail('libc_unavailable');
  return (
    accepted(manifest.os, process.platform) &&
    accepted(manifest.cpu, process.arch) &&
    (process.platform !== 'linux' || accepted(manifest.libc, libc))
  );
}
function dependencies(manifest: Manifest) {
  const result = new Map<string, { optional: boolean }>();
  for (const [field, optional] of [
    [manifest.dependencies, false],
    [manifest.peerDependencies, false],
    [manifest.optionalDependencies, true],
  ] as const) {
    if (field !== undefined && (!field || typeof field !== 'object' || Array.isArray(field)))
      fail('manifest_invalid');
    for (const [name, range] of Object.entries(field ?? {})) {
      if (
        (!validPackageName(name) && !name.startsWith('node:') && !name.startsWith('bun:')) ||
        name === '.' ||
        name === '..' ||
        typeof range !== 'string'
      )
        fail('manifest_invalid');
      const peerOptional =
        field === manifest.peerDependencies &&
        manifest.peerDependenciesMeta?.[name]?.optional === true;
      result.set(name, {
        optional: optional || (peerOptional && result.get(name)?.optional !== false),
      });
    }
  }
  return result;
}
function resolveFixturePackage(name: string, from: string, repository: string) {
  for (let directory = from; inside(repository, directory); directory = dirname(directory)) {
    const path = join(
      basename(directory) === 'node_modules' ? directory : join(directory, 'node_modules'),
      name,
    );
    if (existsSync(join(path, 'package.json'))) return realpathSync(path);
    if (directory === repository) break;
  }
  return undefined;
}

type LockedContext = {
  key: string;
  metadata: BunPackageMetadata;
  peerProviders: ReadonlyMap<string, string>;
};

function patchMarker(bytes: Buffer) {
  // Bun 1.4.4 uses the little-endian first eight bytes of the patch's SHA-1.
  return `.bun-tag-${createHash('sha1').update(bytes).digest().readBigUInt64LE().toString(16)}`;
}

function installedGraph(repository: string) {
  const modules = join(repository, 'node_modules');
  const lockPath = join(repository, bunLockfile);
  const manifestPath = join(repository, 'package.json');
  // Standalone synthetic release fixtures have neither a checkout manifest nor a lock.
  if (!existsSync(lockPath) && !existsSync(manifestPath))
    return (name: string, from: string) => resolveFixturePackage(name, from, repository);
  if (!existsSync(lockPath) || realpathSync(lockPath) !== lockPath) fail('lock_unavailable');
  const store = join(modules, '.bun');
  const lock = parseBunLock(readFileSync(lockPath));
  if (lock.configVersion !== 1 || !existsSync(store) || realpathSync(store) !== store)
    fail('layout_invalid');
  const root = readManifest(repository).manifest;
  const workspacePaths = Object.keys(lock.workspaces).filter(Boolean).sort();
  if (!isDeepStrictEqual([...(root.workspaces ?? [])].sort(), workspacePaths))
    fail('lock_mismatch');
  if (!isDeepStrictEqual({ ...root.patchedDependencies }, { ...lock.patchedDependencies }))
    fail('lock_patch_mismatch');
  const patchFiles = Object.entries(lock.patchedDependencies).map(([id, path]) => {
    const file = join(repository, path);
    if (!existsSync(file) || realpathSync(file) !== file || !lstatSync(file).isFile())
      fail('lock_patch_mismatch');
    return [id, patchMarker(readFileSync(file))] as const;
  });
  const markers = new Map(patchFiles);
  const workspaceContexts = new Map<string, LockedContext>();
  for (const [path, workspace] of Object.entries(lock.workspaces)) {
    const directory = join(repository, path);
    if (realpathSync(directory) !== directory)
      fail('workspace_resolution_mismatch', { name: workspace.name, source: directory });
    const current = readManifest(directory).manifest;
    if (
      workspace.name !== current.name ||
      (workspace.version !== undefined && workspace.version !== current.version) ||
      bunDependencySections.some(
        (field) => !isDeepStrictEqual({ ...workspace[field] }, { ...current[field] }),
      )
    )
      fail('lock_mismatch', { name: workspace.name, source: directory });
    workspaceContexts.set(directory, {
      key: path ? workspace.name : '',
      metadata: workspace,
      peerProviders: new Map(),
    });
  }

  const peerNames = new Set(
    Object.values(lock.packages).flatMap(({ metadata }) =>
      Object.keys(metadata?.peerDependencies ?? {}),
    ),
  );
  const checkedPackages = new Set<string>();
  const checkedContexts = new Set<string>();
  const verifiedEdges = new Map<string, Map<string, string | undefined>>();
  function dependencyKey(name: string, source: LockedContext) {
    const { metadata, key, peerProviders } = source;
    const isPeer =
      Object.hasOwn(metadata.peerDependencies ?? {}, name) &&
      !Object.hasOwn(metadata.dependencies ?? {}, name) &&
      !Object.hasOwn(metadata.optionalDependencies ?? {}, name) &&
      !Object.hasOwn(metadata.devDependencies ?? {}, name);
    return (isPeer && peerProviders.get(name)) || bunDependencyKey(lock, key, name);
  }

  function inheritedProviders(source: LockedContext) {
    const providers = new Map(source.peerProviders);
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies'] as const) {
      for (const name of Object.keys(source.metadata[field] ?? {})) {
        if (!peerNames.has(name)) continue;
        const key = bunDependencyKey(lock, source.key, name);
        if (key) providers.set(name, key);
      }
    }
    return providers;
  }

  function verifyRegistryPackage(expected: BunLockPackage, source: string) {
    const id = `${expected.name}@${expected.version}`;
    if (checkedPackages.has(`${source}\0${id}`)) return;
    const { manifest } = readManifest(source);
    if (manifest.name !== expected.name || manifest.version !== expected.version)
      fail('lock_resolution_mismatch', { name: expected.name, source });
    const storeEntry = relative(store, source).split(sep)[0]!;
    const entryPrefix = id.replace('/', '+');
    if (
      !inside(store, source) ||
      source !== join(store, storeEntry, 'node_modules', expected.name) ||
      (storeEntry !== entryPrefix &&
        !(
          storeEntry.startsWith(`${entryPrefix}+`) &&
          /^[0-9a-f]{16}$/u.test(storeEntry.slice(entryPrefix.length + 1))
        ))
    )
      fail('lock_snapshot_mismatch', { name: expected.name, source });
    const marker = markers.get(id);
    const markerNames = readdirSync(source).filter((name) => /^\.bun-tag-[a-f0-9]+$/u.test(name));
    if (marker ? markerNames.length !== 1 || markerNames[0] !== marker : markerNames.length !== 0)
      fail('lock_patch_mismatch', { name: expected.name, source });
    if (marker) {
      const stamp = lstatSync(join(source, marker));
      if (!stamp.isFile() || stamp.isSymbolicLink() || stamp.size !== 0)
        fail('lock_patch_mismatch', { name: expected.name, source });
    }
    checkedPackages.add(`${source}\0${id}`);
  }

  function dependencySlot(name: string, from: string) {
    const parentDirectory = dirname(from);
    const dependencyDirectory = workspaceContexts.has(from)
      ? join(from, 'node_modules')
      : basename(parentDirectory).startsWith('@')
        ? dirname(parentDirectory)
        : parentDirectory;
    const slot = join(dependencyDirectory, name);
    if (!existsSync(join(slot, 'package.json'))) return undefined;
    if (realpathSync(dependencyDirectory) !== dependencyDirectory)
      fail('lock_snapshot_mismatch', { name, source: from });
    return realpathSync(slot);
  }

  function verifyEdge(name: string, from: string, context: LockedContext): string | undefined {
    const actual = dependencySlot(name, from);
    const key = dependencyKey(name, context);
    if (!key || !Object.hasOwn(lock.packages, key)) {
      if (!actual) return undefined;
      fail('lock_resolution_mismatch', { name, source: from });
    }
    const expected = lock.packages[key]!;
    if (!actual) return undefined;
    if (expected.workspace !== undefined) {
      if (actual !== join(repository, expected.workspace) || !workspaceContexts.has(actual))
        fail('workspace_resolution_mismatch', { name, source: from });
      return actual;
    }
    if (!inside(store, actual)) fail('source_escape', { name, source: from });
    verifyRegistryPackage(expected, actual);
    const peerProviders = inheritedProviders(context);
    const signature = JSON.stringify([actual, key, [...peerProviders].sort()]);
    if (checkedContexts.has(signature)) return actual;
    checkedContexts.add(signature);
    const { manifest } = readManifest(actual);
    const child = { key, metadata: expected.metadata, peerProviders };
    const edges = verifiedEdges.get(actual) ?? new Map<string, string | undefined>();
    for (const [dependency, options] of dependencies(manifest)) {
      if (dependency.startsWith('node:') || dependency.startsWith('bun:')) continue;
      const source = verifyEdge(dependency, actual, child);
      if (!source && !options.optional) fail('missing', { name: dependency, source: actual });
      if (edges.has(dependency) && edges.get(dependency) !== source)
        fail('lock_snapshot_mismatch', { name: dependency, source: actual });
      edges.set(dependency, source);
    }
    verifiedEdges.set(actual, edges);
    return actual;
  }

  return (name: string, from: string) => {
    const workspace = workspaceContexts.get(from);
    if (workspace) return verifyEdge(name, from, workspace);
    const edges = verifiedEdges.get(from);
    if (!edges?.has(name)) fail('lock_source_missing', { name, source: from });
    return edges.get(name);
  };
}

/** Notices cover the installed declared graph of proven bundled roots, conservatively
 * including unused branches. No package code or package-manager scripts execute here.
 */
export function terminalBundledNotices(input: {
  repositoryRoot: string;
  workspaceRoot: string;
  names: readonly string[];
}) {
  const repository = realpathSync(input.repositoryRoot);
  const allowed = realpathSync(join(repository, 'node_modules'));
  const resolveInstalled = installedGraph(repository);
  const workspace = realpathSync(input.workspaceRoot),
    root = readManifest(workspace).manifest;
  const pending: string[] = [];
  for (const name of input.names) {
    if (!validPackageName(name) || !Object.hasOwn(root.dependencies ?? {}, name))
      fail('bundled_dependency_invalid');
    const source = resolveInstalled(name, workspace);
    if (!source) fail('missing', { name, source: workspace });
    pending.push(source);
  }
  const seen = new Set<string>();
  const packages: {
    name: string;
    version: string;
    manifestSha256: string;
    manifestText: string;
    notices: { name: string; sha256: string; text: string }[];
  }[] = [];
  for (let index = 0; index < pending.length; index++) {
    const source = pending[index]!;
    if (seen.has(source)) continue;
    if (!inside(allowed, source)) fail('source_escape');
    seen.add(source);
    const { manifest, bytes } = readManifest(source);
    const manifestText = bytes.toString('utf8');
    if (!Buffer.from(manifestText).equals(bytes)) fail('manifest_invalid');
    const notices = readdirSync(source)
      .filter((name) => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[-_.].*)?$/iu.test(name))
      .sort()
      .map((name) => {
        const file = join(source, name),
          target = realpathSync(file);
        if (
          !inside(source, target) ||
          !lstatSync(file).isFile() ||
          lstatSync(file).isSymbolicLink()
        )
          fail('notice_invalid');
        const bytes = readFileSync(file),
          text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes)) fail('notice_invalid');
        return { name, sha256: createHash('sha256').update(bytes).digest('hex'), text };
      });
    packages.push({
      name: manifest.name,
      version: manifest.version,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'),
      manifestText,
      notices,
    });
    for (const [name, options] of dependencies(manifest)) {
      if (name.startsWith('node:') || name.startsWith('bun:') || name.startsWith('@kite-ai/'))
        continue;
      const child = resolveInstalled(name, source);
      if (!child) {
        if (!options.optional) fail('missing', { name, source });
        continue;
      }
      pending.push(child);
    }
  }
  packages.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version) ||
      a.manifestSha256.localeCompare(b.manifestSha256),
  );
  return {
    version: 1 as const,
    coverage: 'installed-declared-graph' as const,
    roots: [...input.names],
    packages,
  };
}
/** Copy the exact installed resolution graph. No installs, package scripts or source links are used. */
export function copyTerminalDependencies(input: {
  repositoryRoot: string;
  destination: string;
  workspacePackages: readonly TerminalWorkspacePackage[];
  /** Build-only layout; ordinary POSIX candidates retain the original linked graph. */
  dependencyLayout?: 'linked' | 'materialized';
}): TerminalDependencyCopy {
  if (
    input.dependencyLayout !== undefined &&
    input.dependencyLayout !== 'linked' &&
    input.dependencyLayout !== 'materialized'
  )
    fail('layout_invalid');
  const repository = realpathSync(input.repositoryRoot),
    destination = realpathSync(input.destination);
  if (inside(repository, destination) && inside(join(repository, 'node_modules'), destination))
    fail('destination_invalid');
  const allowed = realpathSync(join(repository, 'node_modules'));
  const resolveInstalled = installedGraph(repository);
  const nodes = new Map<string, Node>();
  const workspaces = new Map<string, Node>();
  const report = process.platform === 'linux' ? process.report?.getReport() : undefined;
  const header =
    report && typeof report === 'object'
      ? 'header' in report
        ? report.header
        : undefined
      : undefined;
  const libc =
    header && typeof header === 'object' && 'glibcVersionRuntime' in header
      ? 'glibc'
      : header
        ? 'musl'
        : 'unknown';
  for (const pkg of input.workspacePackages) {
    if (!validPackageName(pkg.name) || workspaces.has(pkg.name)) fail('workspace_invalid');
    const source = realpathSync(pkg.source),
      declaredTarget = resolve(pkg.destination);
    if (
      !existsSync(declaredTarget) ||
      lstatSync(declaredTarget).isSymbolicLink() ||
      !lstatSync(declaredTarget).isDirectory()
    )
      fail('workspace_destination_invalid');
    const target = realpathSync(declaredTarget);
    if (!inside(repository, source) || !inside(destination, target) || target === destination)
      fail('workspace_invalid');
    const { manifest, bytes } = readManifest(source);
    if (manifest.name !== pkg.name) fail('workspace_invalid');
    const bundled = pkg.bundledDependencies ?? [];
    if (
      !Array.isArray(bundled) ||
      new Set(bundled).size !== bundled.length ||
      bundled.some(
        (name) =>
          !validPackageName(name) ||
          name.startsWith('@kite-ai/') ||
          !Object.hasOwn(manifest.dependencies ?? {}, name) ||
          Object.hasOwn(manifest.peerDependencies ?? {}, name) ||
          Object.hasOwn(manifest.optionalDependencies ?? {}, name),
      )
    )
      fail('bundled_dependency_invalid');
    const node: Node = {
      source,
      destination: target,
      manifest,
      bytes,
      edges: new Map(),
      bundledDependencies: new Set(bundled),
    };
    workspaces.set(pkg.name, node);
    nodes.set(source, node);
  }
  const pending = [...workspaces.values()];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index]!;
    for (const [name, options] of dependencies(node.manifest)) {
      if (name.startsWith('node:') || name.startsWith('bun:')) continue;
      if (node.bundledDependencies?.has(name)) continue;
      if (name.startsWith('@kite-ai/') && !workspaces.has(name)) fail('workspace_unknown');
      const installed = resolveInstalled(name, node.source);
      if (!installed) {
        if (options.optional) continue;
        fail('missing', { name, source: node.source });
      }
      const workspace = workspaces.get(name);
      if (workspace) {
        if (installed !== workspace.source) fail('workspace_resolution_mismatch');
        node.edges.set(name, workspace);
        continue;
      }
      if (name.startsWith('@kite-ai/')) fail('workspace_unknown');
      if (!inside(allowed, installed)) fail('source_escape');
      let child = nodes.get(installed);
      if (!child) {
        const { manifest, bytes } = readManifest(installed);
        if (manifest.name.startsWith('@kite-ai/')) fail('workspace_unknown');
        if (!compatible(manifest, libc)) {
          if (options.optional) continue;
          fail('platform_mismatch');
        }
        const key = createHash('sha256')
          .update(relative(repository, installed).split(sep).join('/'))
          .digest('hex');
        child = {
          source: installed,
          destination: join(destination, '.kite-deps', key, 'node_modules', manifest.name),
          manifest,
          bytes,
          edges: new Map(),
        };
        nodes.set(installed, child);
        pending.push(child);
      } else if (!compatible(child.manifest, libc)) {
        if (options.optional) continue;
        fail('platform_mismatch');
      }
      node.edges.set(name, child);
    }
  }
  const result: TerminalDependencyCopy = { packages: [], links: [] };
  const copyPackage = (node: Node, packageTarget: string) => {
    const browserBin =
      node.manifest.name === 'agent-browser' ? join(packageTarget, 'bin') : undefined;
    const browserExecutable = browserBin ? agentBrowserExecutableName() : undefined;
    const bashPrebuilds =
      node.manifest.name === 'tree-sitter-bash' ? join(packageTarget, 'prebuilds') : undefined;
    const targetPlatform = `${process.platform}-${process.arch}`;
    const copy = (source: string, target: string, ancestors: Set<string>) => {
      const canonical = realpathSync(source);
      if (!inside(node.source, canonical)) fail('asset_escape');
      const stat = lstatSync(canonical);
      if (stat.isDirectory()) {
        if (ancestors.has(canonical)) fail('asset_cycle');
        const next = new Set(ancestors);
        next.add(canonical);
        mkdirSync(target, { recursive: true, mode: 0o755 });
        for (const name of readdirSync(canonical).sort()) {
          if (name === 'node_modules') continue;
          if (
            target === bashPrebuilds &&
            name !== targetPlatform &&
            /^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(name)
          )
            continue;
          copy(join(canonical, name), join(target, name), next);
        }
      } else if (stat.isFile()) {
        if (
          browserBin &&
          dirname(target) === browserBin &&
          basename(target) !== browserExecutable &&
          /^agent-browser-(?:darwin|linux(?:-musl)?|win32)-(?:arm64|x64)(?:\.exe)?$/.test(
            basename(target),
          )
        )
          return;
        // Directory recursion has already created the parent; Windows CopyFile
        // also preserves the source read-only attribute without a chmod rewrite.
        if (process.platform !== 'win32')
          mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        copyFileSync(canonical, target);
        if (process.platform !== 'win32')
          chmodSync(
            target,
            browserBin && dirname(target) === browserBin && basename(target) === browserExecutable
              ? 0o755
              : stat.mode & 0o777,
          );
      } else fail('asset_invalid');
    };
    copy(node.source, packageTarget, new Set());
  };
  if (input.dependencyLayout === 'materialized') {
    type Placement = { node: Node; target: string };
    const outer = new Map<string, Placement>();
    for (const [name, node] of workspaces) {
      // This namespace must describe actual Node lookup locations, not desired edges.
      if (node.destination !== join(destination, name)) fail('workspace_destination_invalid');
      outer.set(name, { node, target: node.destination });
    }
    // A real common ancestor can satisfy repeated edges without duplicate files.
    // Pick a deterministic default for each lookup name, preserving the exact
    // source node (including peer context). Conflicts still materialize locally.
    const absent = new Set<string>();
    for (const node of pending)
      for (const name of dependencies(node.manifest).keys())
        if (
          !name.startsWith('node:') &&
          !name.startsWith('bun:') &&
          !node.bundledDependencies?.has(name) &&
          !node.edges.has(name)
        )
          absent.add(name);
    for (const node of pending)
      for (const [name, child] of node.edges)
        if (!outer.has(name) && !absent.has(name))
          outer.set(name, { node: child, target: join(destination, name) });
    const place = (placement: Placement) => {
      if (!inside(destination, placement.target) || existsSync(placement.target))
        fail('destination_exists');
      copyPackage(placement.node, placement.target);
      if (!readFileSync(join(placement.target, 'package.json')).equals(placement.node.bytes))
        fail('content_changed');
      result.packages.push({
        name: placement.node.manifest.name,
        version: placement.node.manifest.version,
        source: placement.node.source,
        destination: relative(destination, placement.target).split(sep).join('/'),
      });
    };
    for (const placement of outer.values())
      if (!workspaces.has(placement.node.manifest.name)) place(placement);
    const materialize = (
      node: Node,
      target: string,
      available: ReadonlyMap<string, Placement>,
      ancestors: ReadonlySet<string>,
    ) => {
      const children: Placement[] = [];
      const resolved = new Map<string, Placement>();
      for (const [name, child] of node.edges) {
        const nearest = available.get(name);
        if (nearest?.node === child) {
          resolved.set(name, nearest);
          continue;
        }
        const placement = { node: child, target: join(target, 'node_modules', name) };
        resolved.set(name, placement);
        children.push(placement);
      }
      const state = JSON.stringify([
        node.source,
        [...available].map(([name, placement]) => [name, placement.node.source]).sort(),
      ]);
      // A shadowing cycle with a repeated resolution state cannot be represented by
      // finite physical ancestry. Reject it rather than changing a version or making links.
      if (children.length && ancestors.has(state)) fail('materialization_cycle');
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(state);
      const nextAvailable = new Map(available);
      // Place every local edge before descending, so peers and cycles see real siblings.
      for (const [name, placement] of resolved) {
        if (available.get(name) === placement) continue;
        place(placement);
        nextAvailable.set(name, placement);
      }
      // npm's derived .bin shims are not consumed by the fixed product frontdoors.
      // Keep the original bin validation and package-local entry bytes, without links
      // or copied shims that would change require.main, argv or relative imports.
      const bins = new Map<string, string>();
      for (const placement of resolved.values()) {
        const declared =
          typeof placement.node.manifest.bin === 'string'
            ? { [placement.node.manifest.name.split('/').at(-1)!]: placement.node.manifest.bin }
            : (placement.node.manifest.bin ?? {});
        for (const [bin, path] of Object.entries(declared)) {
          if (
            !/^[A-Za-z0-9_.-]+$/.test(bin) ||
            bin === '.' ||
            bin === '..' ||
            typeof path !== 'string' ||
            isAbsolute(path) ||
            !inside(placement.target, resolve(placement.target, path))
          )
            fail('bin_invalid');
          const entry = resolve(placement.target, path);
          if (!existsSync(entry) || !lstatSync(entry).isFile()) fail('bin_invalid');
          if (bins.has(bin) && bins.get(bin) !== entry) fail('bin_conflict');
          bins.set(bin, entry);
        }
      }
      for (const placement of children)
        materialize(placement.node, placement.target, nextAvailable, nextAncestors);
    };
    for (const placement of outer.values())
      materialize(placement.node, placement.target, outer, new Set());
    result.packages.sort((a, b) => a.destination.localeCompare(b.destination));
    return result;
  }
  for (const node of pending) {
    if (workspaces.get(node.manifest.name) === node) continue;
    if (existsSync(node.destination)) fail('destination_exists');
    copyPackage(node, node.destination);
    if (!readFileSync(join(node.destination, 'package.json')).equals(node.bytes))
      fail('content_changed');
    result.packages.push({
      name: node.manifest.name,
      version: node.manifest.version,
      source: node.source,
      destination: relative(destination, node.destination).split(sep).join('/'),
    });
  }
  const link = (path: string, target: string) => {
    if (existsSync(path) || !inside(destination, path) || !inside(destination, target))
      fail('link_invalid');
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const relativeTarget = relative(dirname(path), target);
    symlinkSync(relativeTarget, path, 'dir');
    result.links.push({
      path: relative(destination, path).split(sep).join('/'),
      target: relativeTarget.split(sep).join('/'),
    });
  };
  for (const node of pending) {
    const modules = join(node.destination, 'node_modules');
    for (const [name, child] of node.edges) link(join(modules, name), child.destination);
    for (const child of node.edges.values()) {
      const bins =
        typeof child.manifest.bin === 'string'
          ? { [child.manifest.name.split('/').at(-1)!]: child.manifest.bin }
          : (child.manifest.bin ?? {});
      for (const [bin, path] of Object.entries(bins)) {
        if (
          !/^[A-Za-z0-9_.-]+$/.test(bin) ||
          bin === '.' ||
          bin === '..' ||
          typeof path !== 'string' ||
          isAbsolute(path) ||
          !inside(child.destination, resolve(child.destination, path))
        )
          fail('bin_invalid');
        const target = resolve(child.destination, path);
        if (!existsSync(target) || !lstatSync(target).isFile()) fail('bin_invalid');
        const binPath = join(modules, '.bin', bin);
        if (existsSync(binPath)) {
          if (realpathSync(binPath) !== target) fail('bin_conflict');
          continue;
        }
        mkdirSync(dirname(binPath), { recursive: true });
        const value = relative(dirname(binPath), target);
        symlinkSync(value, binPath, 'file');
        result.links.push({
          path: relative(destination, binPath).split(sep).join('/'),
          target: value.split(sep).join('/'),
        });
      }
    }
  }
  result.packages.sort((a, b) => a.destination.localeCompare(b.destination));
  result.links.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
