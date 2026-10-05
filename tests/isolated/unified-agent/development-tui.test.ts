import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectDevelopmentTUI } from '../../../scripts/development/unified-tui';

test('development terminal selects exact built Service bytes after pure argv and never creates a profile during selection', () => {
  const root = mkdtempSync('/private/tmp/kite-development-tui-');
  try {
    const before = readdirSync(root);
    for (const argv of [['--help'], ['--version']]) {
      expect(selectDevelopmentTUI(argv, root)).not.toHaveProperty('artifact');
      expect(readdirSync(root)).toEqual(before);
    }
    expect(() => selectDevelopmentTUI(['--full'], root)).toThrow('invalid_tui_arguments');
    expect(() => selectDevelopmentTUI(['--thread'], root)).toThrow('invalid_tui_arguments');
    expect(() => selectDevelopmentTUI(['--workspace', 'a', '--workspace', 'b'], root)).toThrow(
      'invalid_tui_arguments',
    );
    expect(() => selectDevelopmentTUI([], root)).toThrow('development_service_asset_unavailable');
    expect(
      selectDevelopmentTUI(['--server', '/private/tmp/original.sock'], root),
    ).not.toHaveProperty('artifact');
    expect(readdirSync(root)).toEqual(before);
    const entrypoint = join(root, 'apps/service/dist/main.js');
    mkdirSync(join(root, 'apps/service/dist'), { recursive: true });
    const bytes = 'export const developmentFixture = true;\n';
    writeFileSync(entrypoint, bytes);
    const argv = ['--workspace', '/original', '--thread', 'original'];
    const selected = selectDevelopmentTUI(argv, root);
    argv[1] = '/changed';
    expect(selected.argv[1]).toBe('/original');
    expect(selected).toMatchObject({
      dataRoot: join(root, '.kite-code', 'unified-development'),
      profile: 'development',
      artifact: {
        entrypoint,
        entrypointSha256: createHash('sha256').update(bytes).digest('hex'),
        apiMajor: 1,
      },
    });
    expect(Object.isFrozen(selected)).toBe(true);
    if (!('artifact' in selected)) throw Error('development_service_asset_unavailable');
    expect(Object.isFrozen(selected.artifact)).toBe(true);
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
