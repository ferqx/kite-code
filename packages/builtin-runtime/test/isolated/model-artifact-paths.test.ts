import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelArtifactRoot, userKiteCodeDir } from '../../src/model/artifact-paths';
import { planArtifactRoot } from '../../src/planning/plan-artifact-paths';

const previousKiteCodeHome = process.env.KITE_CODE_HOME;
const temporaryRoots: string[] = [];

afterEach(() => {
  if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
  else process.env.KITE_CODE_HOME = previousKiteCodeHome;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Builtin installation artifact roots', () => {
  test('uses an injected Service code root without appending a second .kite-code', () => {
    const codeRoot = mkdtempSync(join(tmpdir(), 'kite-builtin-code-root-'));
    temporaryRoots.push(codeRoot);
    process.env.KITE_CODE_HOME = codeRoot;

    expect(userKiteCodeDir()).toBe(codeRoot);
    expect(modelArtifactRoot()).toBe(join(codeRoot, 'model-artifacts'));
    expect(planArtifactRoot()).toBe(join(codeRoot, 'plans'));
    expect(userKiteCodeDir()).not.toBe(join(codeRoot, '.kite-code'));
  });

  test('keeps the legacy default when no explicit code root is configured', () => {
    delete process.env.KITE_CODE_HOME;
    expect(userKiteCodeDir()).toBe(join(homedir(), '.kite-code'));
    expect(modelArtifactRoot()).toBe(join(homedir(), '.kite-code', 'model-artifacts'));
  });

  test('an explicit root wins over ambient process configuration', () => {
    const configuredRoot = mkdtempSync(join(tmpdir(), 'kite-builtin-configured-root-'));
    const explicitRoot = mkdtempSync(join(tmpdir(), 'kite-builtin-explicit-root-'));
    temporaryRoots.push(configuredRoot, explicitRoot);
    process.env.KITE_CODE_HOME = configuredRoot;

    expect(userKiteCodeDir(explicitRoot)).toBe(explicitRoot);
    expect(modelArtifactRoot(explicitRoot)).toBe(join(explicitRoot, 'model-artifacts'));
  });
});
