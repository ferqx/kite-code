import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from '../../src/core/tools/file';

describe('workspace path boundary', () => {
  test('file tools reject absolute paths and home expansion', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-boundary-'));
    try {
      const absolute = join(workspace, 'inside.txt');

      expect(writeFile({ workspace, path: absolute, content: 'x' }).ok).toBe(false);
      expect(readFile({ workspace, path: '~/.ssh/config' }).ok).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('file tools reject parent-directory escape', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-boundary-'));
    try {
      const result = writeFile({ workspace, path: '../outside.txt', content: 'x' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('outside workspace');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
