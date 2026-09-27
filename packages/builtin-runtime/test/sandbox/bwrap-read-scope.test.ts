import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBwrapArgs } from '../../src/sandbox/bwrap';

const testRoot = mkdtempSync(join(tmpdir(), 'kite-bwrap-read-scope-'));
const workspace = mkdtempSync(join(testRoot, 'workspace-'));
const runtime = mkdtempSync(join(testRoot, 'runtime-'));
const controlBase = mkdtempSync(join(testRoot, 'control-'));

afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

function operationIndex(args: string[], operation: string, path: string): number {
  return args.findIndex((arg, index) => arg === operation && args[index + 1] === path);
}

describe('Linux broad-read mount policy', () => {
  test('binds the host root read-only before isolated temporary and writable roots', () => {
    const args = generateBwrapArgs(workspace, {
      readScope: 'broad',
      sandboxRuntimeDir: runtime,
      sandboxControlBase: controlBase,
    });
    const canonicalWorkspace = realpathSync.native(workspace);
    const canonicalRuntime = realpathSync.native(runtime);
    const canonicalControlBase = realpathSync.native(controlBase);
    const rootIndex = operationIndex(args, '--ro-bind', '/');
    const tempIndex = operationIndex(args, '--tmpfs', '/tmp');
    const workspaceIndex = operationIndex(args, '--bind', canonicalWorkspace);
    const runtimeIndex = operationIndex(args, '--bind', canonicalRuntime);
    const controlIndex = operationIndex(args, '--tmpfs', canonicalControlBase);

    expect(rootIndex).toBeGreaterThanOrEqual(0);
    expect(args.slice(rootIndex, rootIndex + 3)).toEqual(['--ro-bind', '/', '/']);
    expect(operationIndex(args, '--bind', '/')).toBe(-1);
    expect(tempIndex).toBeGreaterThan(rootIndex);
    expect(workspaceIndex).toBeGreaterThan(tempIndex);
    expect(runtimeIndex).toBeGreaterThan(tempIndex);
    expect(controlIndex).toBeGreaterThan(workspaceIndex);
    expect(controlIndex).toBeGreaterThan(runtimeIndex);
    expect(args.slice(controlIndex, controlIndex + 4)).toEqual([
      '--tmpfs',
      canonicalControlBase,
      '--remount-ro',
      canonicalControlBase,
    ]);
    expect(args).toContain('--unshare-net');
  });

  test('retains the read-only workspace ceiling', () => {
    const args = generateBwrapArgs(workspace, {
      filesystemScope: 'read_only',
      readScope: 'broad',
    });
    const canonicalWorkspace = realpathSync.native(workspace);
    expect(operationIndex(args, '--ro-bind', canonicalWorkspace)).toBeGreaterThanOrEqual(0);
    expect(operationIndex(args, '--bind', canonicalWorkspace)).toBe(-1);
  });

  test('keeps restricted mode as the default', () => {
    const args = generateBwrapArgs(workspace);
    expect(operationIndex(args, '--ro-bind', '/')).toBe(-1);
    expect(operationIndex(args, '--bind', realpathSync.native(workspace))).toBeGreaterThanOrEqual(
      0,
    );
  });
});
