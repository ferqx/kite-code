import { expect, test } from 'bun:test';
import { compareInstalledShellVersions } from '../../../src/jobs/installed-shell-version';

test('installed shell versions compare numeric components and prereleases independently of discovery order', () => {
  for (const [higher, lower] of [
    ['7.10.0', '7.9.9'],
    ['8.0.0', '7.99.99'],
    ['5.1.26100.10066', '5.1.9999.99999'],
    ['7.6.0', '7.6.0-preview.10'],
    ['7.6.0-preview.10', '7.6.0-preview.2'],
    ['7.7.0-preview.1', '7.6.99'],
  ]) {
    expect(compareInstalledShellVersions(higher!, lower!)).toBeGreaterThan(0);
    expect(compareInstalledShellVersions(lower!, higher!)).toBeLessThan(0);
  }
  expect(compareInstalledShellVersions('7.6.0', '7.6.0.0')).toBe(0);
  expect(['5.1.26100.10066', '7.9.9', '7.10.0'].sort(compareInstalledShellVersions).at(-1)).toBe(
    '7.10.0',
  );
});
