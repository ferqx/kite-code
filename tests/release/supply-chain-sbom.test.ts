import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '#kite-test';
import { parseCanonicalJson } from '../../scripts/release/canonical-json';
import {
  encodeSyntheticCycloneDxSbom,
  generateSyntheticCycloneDxSbom,
} from '../../scripts/release/generate-sbom';

describe('synthetic CycloneDX SBOM', () => {
  test('is deterministic, lockfile-bound, sorted, and explicit about missing evidence', () => {
    const input = {
      packageJsonBytes: readFileSync(resolve('package.json')),
      lockfileBytes: readFileSync(resolve('bun.lock')),
    };
    const first = generateSyntheticCycloneDxSbom(input);
    const second = generateSyntheticCycloneDxSbom(input);
    expect(encodeSyntheticCycloneDxSbom(first)).toEqual(encodeSyntheticCycloneDxSbom(second));
    expect(first.bomFormat).toBe('CycloneDX');
    expect(first.specVersion).toBe('1.6');
    expect(first.components.length).toBeGreaterThan(100);
    expect(first.components.find((component) => component.name === '@kite-ai/service')).toEqual({
      type: 'library',
      name: '@kite-ai/service',
      version: 'workspace:apps/service',
      purl: 'pkg:npm/%40kite-ai/service@workspace%3Aapps%2Fservice',
      properties: [
        { name: 'kite-code:dependency-scope', value: 'development' },
        { name: 'kite-code:license-evidence', value: 'not_collected' },
      ],
    });
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
    expect(parseCanonicalJson(encodeSyntheticCycloneDxSbom(first))).toEqual(first);
  });

  test('generates canonical scoped purls and converts canonical sha512 integrity to hex', () => {
    const lock = {
      lockfileVersion: 2,
      workspaces: {
        '': {
          name: 'fixture',
          dependencies: { alias: 'npm:@scope/pkg@^1.2.3' },
          devDependencies: { react: '^19' },
        },
      },
      packages: {
        alias: [
          '@scope/pkg@1.2.3',
          '',
          { peerDependencies: { react: '^19' } },
          `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
        ],
        react: ['react@19.0.0', '', {}, `sha512-${Buffer.alloc(64, 1).toString('base64')}`],
      },
    };
    const sbom = generateSyntheticCycloneDxSbom({
      packageJsonBytes: new TextEncoder().encode('{"name":"fixture","version":"1.0.0"}'),
      lockfileBytes: new TextEncoder().encode(JSON.stringify(lock)),
    });
    expect(sbom.components[0]).toEqual({
      type: 'library',
      name: '@scope/pkg',
      version: '1.2.3',
      purl: 'pkg:npm/%40scope/pkg@1.2.3',
      hashes: [{ alg: 'SHA-512', content: Buffer.alloc(64, 7).toString('hex') }],
      properties: [
        { name: 'kite-code:dependency-scope', value: 'production' },
        { name: 'kite-code:license-evidence', value: 'not_collected' },
      ],
    });
    expect(sbom.components[1]!.properties[0].value).toBe('development');
  });

  test('fails closed on malformed package resolution and registry integrity', () => {
    const packageJsonBytes = new TextEncoder().encode('{"name":"fixture","version":"1.0.0"}');
    const makeLock = (id: string, integrity: string, metadata: Record<string, unknown> = {}) =>
      new TextEncoder().encode(
        JSON.stringify({
          lockfileVersion: 2,
          workspaces: { '': { name: 'fixture' } },
          packages: { pkg: [id, '', metadata, integrity] },
        }),
      );
    expect(() =>
      generateSyntheticCycloneDxSbom({ packageJsonBytes, lockfileBytes: makeLock('invalid', '') }),
    ).toThrow('invalid resolution');
    expect(() =>
      generateSyntheticCycloneDxSbom({
        packageJsonBytes,
        lockfileBytes: makeLock('pkg@1.0.0', 'sha1-invalid'),
      }),
    ).toThrow('not sha512-bound');
    expect(() =>
      generateSyntheticCycloneDxSbom({
        packageJsonBytes,
        lockfileBytes: makeLock('pkg@1.0.0', `sha512-${Buffer.alloc(64).toString('base64')}`, {
          optionalDependencies: { missing: '2.0.0' },
        }),
      }),
    ).toThrow('has no locked resolution');
    expect(() =>
      generateSyntheticCycloneDxSbom({
        packageJsonBytes,
        lockfileBytes: new TextEncoder().encode(
          '{"lockfileVersion":2,"workspaces":{},"workspaces":{}}',
        ),
      }),
    ).toThrow('Duplicate bun.lock key');
  });
});
