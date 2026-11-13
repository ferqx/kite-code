import {
  getNodeValue,
  type Node as JsonNode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';

export const bunLockfile = 'bun.lock';
export const bunDependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
] as const;

type DependencySection = (typeof bunDependencySections)[number];
type DependencyFields = Partial<Record<DependencySection, Record<string, string>>>;

export type BunWorkspace = DependencyFields & {
  name: string;
  version?: string;
};
export type BunPackageMetadata = DependencyFields & { optionalPeers?: string[] };
export type BunLockPackage = { name: string } & (
  | { version: string; integrity: string; metadata: BunPackageMetadata; workspace?: never }
  | { version: string; workspace: string; integrity?: never; metadata?: never }
);
export type BunLock = {
  configVersion: 0 | 1;
  workspaces: Record<string, BunWorkspace>;
  packages: Record<string, BunLockPackage>;
  patchedDependencies: Record<string, string>;
};

const packageName = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/u;
const versionNumber = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/u;

function validPackageName(name: string) {
  return packageName.test(name) && name.split('/').every((part) => part !== '.' && part !== '..');
}

function validWorkspacePath(path: string) {
  return (
    /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(path) &&
    path.split('/').every((part) => part !== '.' && part !== '..')
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${bunLockfile} ${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectDuplicateKeys(node: JsonNode, path: string): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      if (!keyNode || typeof keyNode.value !== 'string' || !valueNode)
        throw Error(`Invalid ${bunLockfile} object member at ${path}.`);
      const key = keyNode.value;
      if (keys.has(key))
        throw Error(`Duplicate ${bunLockfile} key ${JSON.stringify(key)} at ${path}.`);
      keys.add(key);
      rejectDuplicateKeys(valueNode, `${path}.${key}`);
    }
  } else if (node.type === 'array') {
    for (const [index, child] of (node.children ?? []).entries())
      rejectDuplicateKeys(child, `${path}[${index}]`);
  }
}

function bunPackageKeyParts(key: string) {
  const names = key.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [];
  if (names.join('/') !== key || !names.length || names.some((name) => !validPackageName(name)))
    throw Error(`${bunLockfile} package key ${key} is invalid.`);
  return names;
}

export function bunPackageIdentity(resolution: string) {
  const separator = resolution.lastIndexOf('@');
  const name = resolution.slice(0, separator);
  const version = resolution.slice(separator + 1);
  if (separator <= 0 || !validPackageName(name) || !versionNumber.test(version))
    throw Error(`${bunLockfile} package ${resolution} has an invalid resolution.`);
  return { name, version };
}

export function bunIntegrityHash(value: string, key: string) {
  if (!value.startsWith('sha512-'))
    throw Error(`${bunLockfile} package ${key} is not sha512-bound.`);
  const encoded = value.slice('sha512-'.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded)
    throw Error(`${bunLockfile} package ${key} has invalid canonical sha512 integrity.`);
  return bytes.toString('hex');
}

function dependencyFields(value: Record<string, unknown>, label: string) {
  for (const field of bunDependencySections) {
    if (value[field] === undefined) continue;
    for (const [name, range] of Object.entries(object(value[field], `${label} ${field}`))) {
      if (!validPackageName(name) || typeof range !== 'string' || !range)
        throw Error(`${bunLockfile} ${label} has an invalid dependency ${name}.`);
    }
  }
  return value as DependencyFields;
}

/** Look up the nearest explicit resolution in Bun's path-indexed package tree. */
export function bunDependencyKey(lock: BunLock, from: string, name: string): string | undefined {
  const scope = from ? bunPackageKeyParts(from) : [];
  for (let depth = scope.length; depth > 0; depth--) {
    const key = `${scope.slice(0, depth).join('/')}/${name}`;
    if (Object.hasOwn(lock.packages, key)) return key;
  }
  return Object.hasOwn(lock.packages, name) ? name : undefined;
}

/** Parse Bun's JSON-with-trailing-commas registry/workspace lock, including retained v1 inputs. */
export function parseBunLock(input: Uint8Array): BunLock {
  const errors: ParseError[] = [];
  const root = parseTree(new TextDecoder('utf-8', { fatal: true }).decode(input), errors, {
    allowTrailingComma: true,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (!root || errors.length) {
    const first = errors[0];
    const detail = first
      ? `${printParseErrorCode(first.error)} at byte ${first.offset}`
      : 'empty document';
    throw Error(`Invalid ${bunLockfile}: ${detail}.`);
  }
  rejectDuplicateKeys(root, '$');
  const value = object(getNodeValue(root), 'document');
  const configVersion = value.configVersion ?? 0;
  if (
    (value.lockfileVersion !== 1 && value.lockfileVersion !== 2) ||
    (configVersion !== 0 && configVersion !== 1)
  )
    throw Error(`${bunLockfile} has an unsupported version.`);
  const rawWorkspaces = object(value.workspaces, 'workspaces');
  if (!Object.hasOwn(rawWorkspaces, '')) throw Error(`${bunLockfile} lacks the root workspace.`);
  const workspaces: BunLock['workspaces'] = Object.fromEntries(
    Object.entries(rawWorkspaces).map(([path, raw]) => {
      const workspace = object(raw, `workspace ${path}`);
      const { name, version } = workspace;
      if (
        (path !== '' && !validWorkspacePath(path)) ||
        typeof name !== 'string' ||
        !validPackageName(name) ||
        (version !== undefined && (typeof version !== 'string' || !versionNumber.test(version)))
      )
        throw Error(`${bunLockfile} workspace ${path} is invalid.`);
      return [path, { ...dependencyFields(workspace, `workspace ${path}`), name, version }];
    }),
  );
  const packages: BunLock['packages'] = Object.fromEntries(
    Object.entries(object(value.packages, 'packages')).map(([key, raw]) => {
      bunPackageKeyParts(key);
      if (!Array.isArray(raw) || typeof raw[0] !== 'string')
        throw Error(`${bunLockfile} package ${key} has an invalid entry.`);
      const [resolution, registry, rawMetadata, integrity] = raw;
      const workspaceSeparator = resolution.indexOf('@workspace:');
      if (workspaceSeparator !== -1) {
        const name = resolution.slice(0, workspaceSeparator);
        const workspace = resolution.slice(workspaceSeparator + '@workspace:'.length);
        if (
          raw.length !== 1 ||
          !validPackageName(name) ||
          !validWorkspacePath(workspace) ||
          !Object.hasOwn(workspaces, workspace) ||
          workspaces[workspace]!.name !== name
        )
          throw Error(`${bunLockfile} package ${key} has an invalid workspace resolution.`);
        return [key, { name, version: `workspace:${workspace}`, workspace }];
      }
      const identity = bunPackageIdentity(resolution);
      if (
        raw.length !== 4 ||
        typeof registry !== 'string' ||
        (registry !== '' && !/^https?:\/\/[^\s?#]+$/u.test(registry)) ||
        typeof integrity !== 'string'
      )
        throw Error(`${bunLockfile} package ${key} has an invalid registry entry.`);
      bunIntegrityHash(integrity, key);
      const rawFields = object(rawMetadata, `package ${key} metadata`);
      const metadata: BunPackageMetadata = dependencyFields(rawFields, `package ${key}`);
      const optionalPeers = rawFields.optionalPeers;
      if (optionalPeers !== undefined) {
        if (
          !Array.isArray(optionalPeers) ||
          optionalPeers.some(
            (peer) =>
              typeof peer !== 'string' || !Object.hasOwn(metadata.peerDependencies ?? {}, peer),
          ) ||
          new Set(optionalPeers).size !== optionalPeers.length
        )
          throw Error(`${bunLockfile} package ${key} has invalid optional peers.`);
        metadata.optionalPeers = optionalPeers;
      }
      return [key, { ...identity, integrity, metadata }];
    }),
  );
  const identities = new Map<string, string>();
  for (const { name, version, integrity } of Object.values(packages)) {
    if (!integrity) continue;
    const id = `${name}@${version}`;
    if (identities.has(id) && identities.get(id) !== integrity)
      throw Error(`${bunLockfile} repeats ${id} with different integrity.`);
    identities.set(id, integrity);
  }
  const patchedDependencies: BunLock['patchedDependencies'] = Object.fromEntries(
    Object.entries(
      value.patchedDependencies === undefined
        ? {}
        : object(value.patchedDependencies, 'patched dependencies'),
    ).map(([id, patch]) => {
      if (
        !identities.has(id) ||
        typeof patch !== 'string' ||
        !/^patches\/[a-zA-Z0-9@.%_+-]+\.patch$/u.test(patch)
      )
        throw Error(`${bunLockfile} patch ${id} is invalid.`);
      return [id, patch];
    }),
  );
  const lock: BunLock = { configVersion, workspaces, packages, patchedDependencies };
  const validate = (from: string, metadata: BunPackageMetadata) => {
    for (const field of bunDependencySections) {
      for (const name of Object.keys(metadata[field] ?? {})) {
        if (
          !(field === 'peerDependencies' && metadata.optionalPeers?.includes(name)) &&
          !bunDependencyKey(lock, from, name)
        )
          throw Error(
            `${bunLockfile} dependency ${name} of ${from || 'root'} has no locked resolution.`,
          );
      }
    }
  };
  for (const [path, workspace] of Object.entries(workspaces))
    validate(path ? workspace.name : '', workspace);
  for (const [key, entry] of Object.entries(packages)) {
    if (entry.metadata) validate(key, entry.metadata);
  }
  return lock;
}
