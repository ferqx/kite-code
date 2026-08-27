import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  buildHardenedEnv,
  selectedDarwinDeveloperBin,
} from '../src/sandbox/execution/local-shell-preparation';

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local shell preparation', () => {
  test('uses the selected Darwin developer binaries without invoking the xcrun shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-shell-preparation-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const runtime = join(root, 'runtime');
    mkdirSync(workspace);
    mkdirSync(runtime);
    process.env.PATH = '/usr/bin:/bin';

    const env = buildHardenedEnv(workspace, runtime);
    const developerBin = selectedDarwinDeveloperBin();
    if (process.platform === 'darwin' && developerBin) {
      expect(env.PATH?.split(delimiter)[0]).toBe(developerBin);
      expect(existsSync(join(developerBin, 'git'))).toBe(true);
    } else {
      expect(env.PATH).toBe('/usr/bin:/bin');
    }
    expect(env.TMPDIR).toBe(join(realpathSync.native(runtime), 'tmp'));
  });
});
