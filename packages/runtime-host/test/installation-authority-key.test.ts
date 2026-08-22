import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadOrCreateRuntimeInstallationAuthorityKeyV1,
  RuntimeInstallationAuthorityKeyErrorV1,
} from '../src/installation-authority-key';

test('installation authority key is stable, owner-only and bound to its digest', () => {
  const root = mkdtempSync(join(process.cwd(), '.kite-runtime-installation-key-'));
  const keyPath = join(root, 'runtime-authority.key');
  try {
    const first = loadOrCreateRuntimeInstallationAuthorityKeyV1({
      keyPath,
      authorityEvidencePaths: [join(root, 'project-identities-v1.json')],
      randomKey: () => new Uint8Array(32).fill(4),
    });
    const second = loadOrCreateRuntimeInstallationAuthorityKeyV1({
      keyPath,
      authorityEvidencePaths: [join(root, 'project-identities-v1.json')],
      randomKey: () => new Uint8Array(32).fill(9),
    });
    expect(second.key).toEqual(first.key);
    expect(second.keyId).toBe(first.keyId);
    expect(first.keyId).toMatch(/^sha256:[a-f0-9]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installation authority key loss, zero material and symlink paths fail closed', () => {
  const root = mkdtempSync(join(process.cwd(), '.kite-runtime-installation-key-negative-'));
  try {
    const evidence = join(root, 'project-identities-v1.json');
    writeFileSync(evidence, '{}');
    expect(() =>
      loadOrCreateRuntimeInstallationAuthorityKeyV1({
        keyPath: join(root, 'runtime-authority.key'),
        authorityEvidencePaths: [evidence],
      }),
    ).toThrow(RuntimeInstallationAuthorityKeyErrorV1);

    rmSync(evidence);
    expect(() =>
      loadOrCreateRuntimeInstallationAuthorityKeyV1({
        keyPath: join(root, 'runtime-authority.key'),
        authorityEvidencePaths: [],
        randomKey: () => new Uint8Array(32),
      }),
    ).toThrow('invalid');

    const target = join(root, 'target');
    mkdirSync(target);
    const alias = join(root, 'alias');
    symlinkSync(target, alias);
    expect(() =>
      loadOrCreateRuntimeInstallationAuthorityKeyV1({
        keyPath: join(alias, 'runtime-authority.key'),
        authorityEvidencePaths: [],
      }),
    ).toThrow('directory is unsafe');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
