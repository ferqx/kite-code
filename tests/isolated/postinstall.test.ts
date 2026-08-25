import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

describe('cross-platform postinstall bootstrap', () => {
  test('initializes as an ES module without Node 20-only path globals or side effects', () => {
    const source = readFileSync('scripts/postinstall.js', 'utf8');
    expect(source).not.toContain('import.meta.dirname');
    expect(source).not.toContain('npx lefthook');
    expect(source).toContain('fileURLToPath(import.meta.url)');
    expect(source).toContain('createRequire(import.meta.url)');
    expect(source).toContain("execFileSync('bun', ['x', 'lefthook', 'install', '-f']");

    const result = spawnSync(
      'node',
      ['--input-type=module', '--eval', "await import('./scripts/postinstall.js')"],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
