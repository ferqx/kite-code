import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  getNodeValue,
  type Node as JsonNode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import { canonicalJsonBytes, parseStrictJson, sha256Digest } from './canonical-json';

interface BunLockPackageEntry {
  resolution: string;
  integrity?: string;
}

export interface SyntheticCycloneDxComponentV1 {
  type: 'library';
  name: string;
  version: string;
  purl: string;
  hashes?: [{ alg: 'SHA-512'; content: string }];
  properties: [
    { name: 'kite-code:dependency-scope'; value: 'production' | 'development' | 'transitive' },
    { name: 'kite-code:license-evidence'; value: 'not_collected' },
  ];
}

export interface SyntheticCycloneDxSbomV1 {
  bomFormat: 'CycloneDX';
  specVersion: '1.6';
  version: 1;
  metadata: {
    component: { type: 'application'; name: string; version: string };
    properties: [
      { name: 'kite-code:non-distributable'; value: 'true' },
      { name: 'kite-code:production-evidence'; value: 'false' },
      { name: 'kite-code:registry-audit-status'; value: 'not_run' },
      { name: 'kite-code:license-scan-status'; value: 'not_run' },
      { name: 'kite-code:source-lockfile-sha256'; value: `sha256:${string}` },
    ];
  };
  components: SyntheticCycloneDxComponentV1[];
}

/** Deterministic SBOM contract; it does not claim vulnerability or license evidence. */
export function generateSyntheticCycloneDxSbomV1(input: {
  packageJsonBytes: Uint8Array;
  bunLockBytes: Uint8Array;
}): SyntheticCycloneDxSbomV1 {
  const packageJson = expectObject(parseStrictJson(input.packageJsonBytes), 'package.json');
  const lock = expectObject(parseBunLock(input.bunLockBytes), 'bun.lock');
  const rootName = expectString(packageJson.name, 'package.json.name');
  const rootVersion = expectString(packageJson.version, 'package.json.version');
  const workspaces = expectObject(lock.workspaces, 'bun.lock.workspaces');
  const rootWorkspace = expectObject(workspaces[''], 'bun.lock.workspaces[""]');
  const productionDependencies = dependencyNames(rootWorkspace.dependencies);
  const developmentDependencies = dependencyNames(rootWorkspace.devDependencies);
  const packages = expectObject(lock.packages, 'bun.lock.packages');

  const componentsByPurl = new Map<string, SyntheticCycloneDxComponentV1>();
  for (const [key, rawEntry] of Object.entries(packages)) {
    const entry = parseBunLockPackageEntry(rawEntry, key);
    const { name, version } = packageIdentity(entry.resolution, key);
    const scope: SyntheticCycloneDxComponentV1['properties'][0]['value'] =
      key === name && productionDependencies.has(name)
        ? 'production'
        : key === name && developmentDependencies.has(name)
          ? 'development'
          : 'transitive';
    const integrity = entry.integrity ? integrityHash(entry.integrity, key) : undefined;
    const hashes: SyntheticCycloneDxComponentV1['hashes'] = integrity
      ? [{ alg: 'SHA-512', content: integrity }]
      : undefined;
    const purl = npmPurl(name, version);
    const existing = componentsByPurl.get(purl);
    if (existing) {
      if (existing.hashes?.[0]?.content !== hashes?.[0]?.content) {
        throw new Error(`bun.lock repeats ${purl} with different integrity.`);
      }
      const existingScope = existing.properties[0].value;
      existing.properties[0].value = tighterDependencyScope(existingScope, scope);
      continue;
    }
    const properties: SyntheticCycloneDxComponentV1['properties'] = [
      { name: 'kite-code:dependency-scope', value: scope },
      { name: 'kite-code:license-evidence', value: 'not_collected' },
    ];
    componentsByPurl.set(purl, {
      type: 'library',
      name,
      version,
      purl,
      ...(hashes ? { hashes } : {}),
      properties,
    });
  }
  const components = [...componentsByPurl.values()].sort((left, right) =>
    compareStrings(left.purl, right.purl),
  );

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'application', name: rootName, version: rootVersion },
      properties: [
        { name: 'kite-code:non-distributable', value: 'true' },
        { name: 'kite-code:production-evidence', value: 'false' },
        { name: 'kite-code:registry-audit-status', value: 'not_run' },
        { name: 'kite-code:license-scan-status', value: 'not_run' },
        { name: 'kite-code:source-lockfile-sha256', value: sha256Digest(input.bunLockBytes) },
      ],
    },
    components,
  };
}

export function encodeSyntheticCycloneDxSbomV1(sbom: SyntheticCycloneDxSbomV1): Uint8Array {
  return canonicalJsonBytes(sbom);
}

function parseBunLockPackageEntry(value: unknown, key: string): BunLockPackageEntry {
  if (!Array.isArray(value) || typeof value[0] !== 'string') {
    throw new Error(`bun.lock package ${key} has an invalid entry.`);
  }
  const integrity = value[3];
  if (integrity !== undefined && typeof integrity !== 'string') {
    throw new Error(`bun.lock package ${key} has an invalid integrity value.`);
  }
  return { resolution: value[0], ...(integrity ? { integrity } : {}) };
}

function parseBunLock(input: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (!root || errors.length > 0) {
    const first = errors[0];
    const detail = first
      ? `${printParseErrorCode(first.error)} at byte ${first.offset}`
      : 'empty document';
    throw new Error(`Invalid bun.lock: ${detail}.`);
  }
  rejectDuplicateKeys(root, '$');
  return getNodeValue(root) as unknown;
}

function rejectDuplicateKeys(node: JsonNode, path: string): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      if (!keyNode || typeof keyNode.value !== 'string' || !valueNode) {
        throw new Error(`Invalid bun.lock object member at ${path}.`);
      }
      if (keys.has(keyNode.value)) {
        throw new Error(`Duplicate bun.lock key ${JSON.stringify(keyNode.value)} at ${path}.`);
      }
      keys.add(keyNode.value);
      rejectDuplicateKeys(valueNode, `${path}.${keyNode.value}`);
    }
  } else if (node.type === 'array') {
    for (const [index, child] of (node.children ?? []).entries()) {
      rejectDuplicateKeys(child, `${path}[${index}]`);
    }
  }
}

function packageIdentity(resolution: string, key: string): { name: string; version: string } {
  const separator = resolution.lastIndexOf('@');
  if (separator <= 0 || separator === resolution.length - 1) {
    throw new Error(`bun.lock package ${key} has an invalid resolution.`);
  }
  const name = resolution.slice(0, separator);
  const version = resolution.slice(separator + 1);
  if (!name || !version || /[\s?#]/.test(name) || /[\s?#]/.test(version)) {
    throw new Error(`bun.lock package ${key} has an invalid package identity.`);
  }
  return { name, version };
}

function npmPurl(name: string, version: string): string {
  const encodedName = name.startsWith('@')
    ? `%40${encodeURIComponent(name.slice(1)).replace('%2F', '/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function integrityHash(value: string, key: string): string {
  if (!value.startsWith('sha512-')) throw new Error(`bun.lock package ${key} is not sha512-bound.`);
  const bytes = Buffer.from(value.slice('sha512-'.length), 'base64');
  if (bytes.byteLength !== 64 || bytes.toString('base64') !== value.slice('sha512-'.length)) {
    throw new Error(`bun.lock package ${key} has invalid canonical sha512 integrity.`);
  }
  return bytes.toString('hex');
}

function dependencyNames(value: unknown): Set<string> {
  if (value === undefined) return new Set();
  return new Set(Object.keys(expectObject(value, 'workspace dependencies')));
}

function tighterDependencyScope(
  left: SyntheticCycloneDxComponentV1['properties'][0]['value'],
  right: SyntheticCycloneDxComponentV1['properties'][0]['value'],
): SyntheticCycloneDxComponentV1['properties'][0]['value'] {
  const rank = { transitive: 0, development: 1, production: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? '.');
  const output = resolve(process.argv[3] ?? 'dist/release-synthetic/sbom.cdx.json');
  const sbom = generateSyntheticCycloneDxSbomV1({
    packageJsonBytes: readFileSync(resolve(root, 'package.json')),
    bunLockBytes: readFileSync(resolve(root, 'bun.lock')),
  });
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, encodeSyntheticCycloneDxSbomV1(sbom), { mode: 0o600 });
}
