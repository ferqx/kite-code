import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bunDependencySections, bunIntegrityHash, bunLockfile, parseBunLock } from './bun-lock';
import { canonicalJsonBytes, parseStrictJson, sha256Digest } from './canonical-json';

export interface SyntheticCycloneDxComponent {
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

export interface SyntheticCycloneDxSbom {
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
  components: SyntheticCycloneDxComponent[];
}

/** Deterministic SBOM contract; it does not claim vulnerability or license evidence. */
export function generateSyntheticCycloneDxSbom(input: {
  packageJsonBytes: Uint8Array;
  lockfileBytes: Uint8Array;
}): SyntheticCycloneDxSbom {
  const packageJson = expectObject(parseStrictJson(input.packageJsonBytes), 'package.json');
  const lock = parseBunLock(input.lockfileBytes);
  const rootName = expectString(packageJson.name, 'package.json.name');
  const rootVersion = expectString(packageJson.version, 'package.json.version');
  const root = lock.workspaces['']!;
  const directScopes = new Map<string, SyntheticCycloneDxComponent['properties'][0]['value']>();
  for (const field of [...bunDependencySections].reverse()) {
    for (const name of Object.keys(root[field] ?? {})) {
      directScopes.set(name, field === 'devDependencies' ? 'development' : 'production');
    }
  }
  const componentsByPurl = new Map<string, SyntheticCycloneDxComponent>();
  for (const [key, { name, version, integrity }] of Object.entries(lock.packages)) {
    const purl = npmPurl(name, version);
    const scope = directScopes.get(key) ?? 'transitive';
    const existing = componentsByPurl.get(purl);
    if (existing) {
      const previous = existing.properties[0].value;
      if (scope === 'production' || (scope === 'development' && previous === 'transitive'))
        existing.properties[0].value = scope;
      continue;
    }
    componentsByPurl.set(purl, {
      type: 'library',
      name,
      version,
      purl,
      ...(integrity
        ? { hashes: [{ alg: 'SHA-512', content: bunIntegrityHash(integrity, key) }] }
        : {}),
      properties: [
        { name: 'kite-code:dependency-scope', value: scope },
        { name: 'kite-code:license-evidence', value: 'not_collected' },
      ],
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
        { name: 'kite-code:source-lockfile-sha256', value: sha256Digest(input.lockfileBytes) },
      ],
    },
    components,
  };
}

export function encodeSyntheticCycloneDxSbom(sbom: SyntheticCycloneDxSbom): Uint8Array {
  return canonicalJsonBytes(sbom);
}

function npmPurl(name: string, version: string): string {
  const encodedName = name.startsWith('@')
    ? `%40${encodeURIComponent(name.slice(1)).replace('%2F', '/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
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

if (Reflect.get(import.meta, 'main') === true) {
  const root = resolve(process.argv[2] ?? '.');
  const output = resolve(process.argv[3] ?? 'dist/release-synthetic/sbom.cdx.json');
  const sbom = generateSyntheticCycloneDxSbom({
    packageJsonBytes: readFileSync(resolve(root, 'package.json')),
    lockfileBytes: readFileSync(resolve(root, bunLockfile)),
  });
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, encodeSyntheticCycloneDxSbom(sbom), { mode: 0o600 });
}
