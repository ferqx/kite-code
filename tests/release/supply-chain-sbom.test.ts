import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCanonicalJson } from '../../scripts/release/canonical-json';
import {
  encodeSyntheticCycloneDxSbomV1,
  generateSyntheticCycloneDxSbomV1,
} from '../../scripts/release/generate-sbom';

describe('synthetic CycloneDX SBOM', () => {
  test('is deterministic, lockfile-bound, sorted, and explicit about missing evidence', () => {
    const input = {
      packageJsonBytes: readFileSync(resolve('package.json')),
      bunLockBytes: readFileSync(resolve('bun.lock')),
    };
    const first = generateSyntheticCycloneDxSbomV1(input);
    const second = generateSyntheticCycloneDxSbomV1(input);
    expect(encodeSyntheticCycloneDxSbomV1(first)).toEqual(encodeSyntheticCycloneDxSbomV1(second));
    expect(first.bomFormat).toBe('CycloneDX');
    expect(first.specVersion).toBe('1.6');
    expect(first.components.length).toBeGreaterThan(100);
    expect(first.components.map((component) => component.purl)).toEqual(
      [...first.components.map((component) => component.purl)].sort(),
    );
    expect(first.metadata.properties).toContainEqual({
      name: 'kite-code:registry-audit-status',
      value: 'not_run',
    });
    expect(first.metadata.properties).toContainEqual({
      name: 'kite-code:license-scan-status',
      value: 'not_run',
    });
    expect(
      first.components.every((component) =>
        component.properties.some(
          (property) =>
            property.name === 'kite-code:license-evidence' && property.value === 'not_collected',
        ),
      ),
    ).toBe(true);
    expect(parseCanonicalJson(encodeSyntheticCycloneDxSbomV1(first))).toEqual(first);
  });

  test('generates canonical scoped purls and converts canonical sha512 integrity to hex', () => {
    const lock = {
      lockfileVersion: 1,
      workspaces: {
        '': {
          dependencies: { '@scope/pkg': '^1.2.3' },
          devDependencies: {},
        },
      },
      packages: {
        '@scope/pkg': [
          '@scope/pkg@1.2.3',
          'https://registry.example/pkg.tgz',
          {},
          `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
        ],
      },
    };
    const sbom = generateSyntheticCycloneDxSbomV1({
      packageJsonBytes: new TextEncoder().encode('{"name":"fixture","version":"1.0.0"}'),
      bunLockBytes: new TextEncoder().encode(JSON.stringify(lock)),
    });
    expect(sbom.components).toEqual([
      {
        type: 'library',
        name: '@scope/pkg',
        version: '1.2.3',
        purl: 'pkg:npm/%40scope/pkg@1.2.3',
        hashes: [{ alg: 'SHA-512', content: Buffer.alloc(64, 7).toString('hex') }],
        properties: [
          { name: 'kite-code:dependency-scope', value: 'production' },
          { name: 'kite-code:license-evidence', value: 'not_collected' },
        ],
      },
    ]);
  });

  test('fails closed on malformed package resolution and registry integrity', () => {
    const packageJsonBytes = new TextEncoder().encode('{"name":"fixture","version":"1.0.0"}');
    const makeLock = (entry: unknown) =>
      new TextEncoder().encode(
        JSON.stringify({ workspaces: { '': {} }, packages: { invalid: entry } }),
      );
    expect(() =>
      generateSyntheticCycloneDxSbomV1({ packageJsonBytes, bunLockBytes: makeLock(['invalid']) }),
    ).toThrow('invalid resolution');
    expect(() =>
      generateSyntheticCycloneDxSbomV1({
        packageJsonBytes,
        bunLockBytes: makeLock(['pkg@1.0.0', 'url', {}, 'sha1-invalid']),
      }),
    ).toThrow('not sha512-bound');
  });
});
