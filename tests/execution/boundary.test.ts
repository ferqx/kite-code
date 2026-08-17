import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from '../helpers/legacy-workspace-filesystem-file';

describe('workspace path boundary', () => {
  test('file tools allow absolute paths inside workspace, reject ~ and parent escape', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-boundary-'));
    try {
      const absolute = join(workspace, 'inside.txt');
      // Absolute path that resolves inside workspace → allowed
      expect(writeFile({ workspace, path: absolute, content: 'x' }).ok).toBe(true);
      // ~ home expansion → still rejected
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
