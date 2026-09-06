import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');

describe('current documentation navigation', () => {
  test('provides a README for every real workspace', () => {
    for (const parent of ['apps', 'packages']) {
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(join(root, parent, entry.name, 'package.json')))
          continue;
        expect(existsSync(join(root, parent, entry.name, 'README.md'))).toBe(true);
      }
    }
  });

  test('indexes every current cross-workspace contract exactly once', () => {
    const index = readFileSync(join(root, 'docs/development/subsystems/contracts.md'), 'utf8');
    for (const file of readdirSync(join(root, 'docs/active')).filter((name) =>
      name.endsWith('.md'),
    )) {
      expect(index.split(`(../../active/${file})`).length - 1, file).toBe(1);
    }
  });
});
