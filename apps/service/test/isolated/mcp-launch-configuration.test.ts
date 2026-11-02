import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { resolveMcpLaunchEntry } from '../../src/mcp-launch-configuration';

test('a named launcher resolves only through explicit absolute PATH directories and keeps argv separate', () => {
  const entry = resolveMcpLaunchEntry(
    { type: 'stdio', command: basename(process.execPath), args: ['two words', 'quote"value'] },
    (name) => (name === 'PATH' ? ['.', dirname(process.execPath)].join(delimiter) : undefined),
  );
  expect(entry).toMatchObject({
    type: 'stdio',
    command: realpathSync.native(process.execPath),
    args: ['two words', 'quote"value'],
  });
});
test('a relative PATH entry cannot turn the current working directory into launcher authority', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-path-'))),
    prior = process.cwd();
  const name = process.platform === 'win32' ? 'probe.exe' : 'probe';
  try {
    writeFileSync(join(root, name), 'synthetic-not-executed', { mode: 0o700 });
    process.chdir(root);
    expect(() =>
      resolveMcpLaunchEntry({ type: 'stdio', command: name }, (key) =>
        key === 'PATH' ? '.' : undefined,
      ),
    ).toThrow('mcp_command_not_found');
  } finally {
    process.chdir(prior);
    rmSync(root, { recursive: true, force: true });
  }
});
