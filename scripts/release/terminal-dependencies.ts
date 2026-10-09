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
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  dependencies?: Record<string, string>;
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
function fail(code: string): never {
  throw new Error(`terminal_dependency_${code}`);
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
function resolvePackage(name: string, from: string) {
  // A declared npm dependency may share a built-in name, e.g. punycode -> require('punycode/').
  for (const search of createRequire(join(from, 'package.json')).resolve.paths(
    `${name}/package.json`,
  ) ?? []) {
    const path = join(search, name);
    if (existsSync(join(path, 'package.json'))) return realpathSync(path);
  }
  return undefined;
}
/** Copy the exact installed resolution graph. No installs, package scripts or source links are used. */
export function copyTerminalDependencies(input: {
  repositoryRoot: string;
  destination: string;
  workspacePackages: readonly TerminalWorkspacePackage[];
}): TerminalDependencyCopy {
  const repository = realpathSync(input.repositoryRoot),
    destination = realpathSync(input.destination);
  if (inside(repository, destination) && inside(join(repository, 'node_modules'), destination))
    fail('destination_invalid');
  const allowed = realpathSync(join(repository, 'node_modules'));
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
      const installed = resolvePackage(name, node.source);
      if (!installed) {
        if (options.optional) continue;
        fail('missing');
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
  const copy = (source: string, target: string, root: string, ancestors: Set<string>) => {
    const canonical = realpathSync(source);
    if (!inside(root, canonical)) fail('asset_escape');
    const stat = lstatSync(canonical);
    if (stat.isDirectory()) {
      if (ancestors.has(canonical)) fail('asset_cycle');
      const next = new Set(ancestors);
      next.add(canonical);
      mkdirSync(target, { recursive: true, mode: 0o755 });
      for (const name of readdirSync(canonical).sort()) {
        if (name === 'node_modules') continue;
        copy(join(canonical, name), join(target, name), root, next);
      }
    } else if (stat.isFile()) {
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      copyFileSync(canonical, target);
      chmodSync(target, stat.mode & 0o777);
    } else fail('asset_invalid');
  };
  for (const node of pending) {
    if (workspaces.get(node.manifest.name) === node) continue;
    if (existsSync(node.destination)) fail('destination_exists');
    copy(node.source, node.destination, node.source, new Set());
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
