import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeMcpStdioProcessEvidence,
  type McpStdioLinuxEvidence,
} from '../../../src/mcp/stdio-process-evidence';

const binding = {
  originalStoreId: 'store',
  sessionId: 'session',
  executionId: 'execution',
  serverId: 'server',
  scopeId: JSON.stringify(['store', 'session', 'server']),
  configDigest: 'digest',
};
function receipt(): McpStdioLinuxEvidence {
  return {
    version: 4,
    coverage: 'mcp-owned-pid-namespace',
    binding,
    ownerPid: 100,
    process: {
      version: 1,
      coverage: 'linux-pid-namespace',
      ownerPid: 100,
      admission: { nonce: 'original_linux_nonce', purpose: 'stdio' },
      wrapper: {
        pid: 101,
        birth: '1010',
        parentPid: 100,
        exit: { code: 0, signal: null, reaped: true },
        closed: true,
        stdoutEof: true,
        stderrEof: true,
      },
      namespace: {
        dev: '7',
        ino: '71',
        init: { pid: 102, birth: '1020', parentPid: 101, localPid: 1, dead: true },
        root: {
          pid: 103,
          birth: '1030',
          parentPid: 102,
          localPid: 2,
          dead: true,
          waitReceipt: {
            localPid: 2,
            code: 7,
            signal: null,
            rawStatus: 7 * 256,
            waitConfirmed: true,
            reaped: true,
          },
        },
        treeStopped: true,
      },
      phase: 'terminal',
      fdClosed: true,
      closeUnknown: false,
    },
  };
}
test('Linux cold MCP proof retains original scope and requires the complete namespace disposal conjunction', () => {
  const original = receipt();
  const decoded = decodeMcpStdioProcessEvidence(original, binding, 100);
  expect(decoded).toEqual(original);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(decoded?.version === 4 && Object.isFrozen(decoded.process.namespace?.root)).toBe(true);
  for (const key of Object.keys(binding) as (keyof typeof binding)[]) {
    expect(
      decodeMcpStdioProcessEvidence(original, { ...binding, [key]: 'another-original' }, 100),
    ).toBeUndefined();
  }
  const mutate = (change: (value: McpStdioLinuxEvidence) => void) => {
    const value = structuredClone(original);
    change(value);
    expect(decodeMcpStdioProcessEvidence(value, binding, 100)).toBeUndefined();
  };
  mutate((value) => {
    value.process.namespace!.root!.waitReceipt!.rawStatus = 0;
  });
  mutate((value) => {
    value.process.namespace!.root!.parentPid = 101;
  });
  mutate((value) => {
    value.process.namespace!.init.dead = false;
  });
  mutate((value) => {
    value.process.wrapper.stderrEof = false;
  });
  mutate((value) => {
    value.process.fdClosed = false;
  });
  mutate((value) => {
    value.process.closeUnknown = true;
  });
  expect(
    decodeMcpStdioProcessEvidence(
      {
        ...original,
        process: {
          ...original.process,
          admission: { nonce: 'original_linux_nonce', mode: 'full' },
        },
      },
      binding,
      100,
    ),
  ).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence({ ...original, guardian: {} }, binding, 100),
  ).toBeUndefined();
  const unknown = structuredClone(original);
  unknown.process.phase = 'unknown';
  unknown.process.fdClosed = false;
  unknown.process.closeUnknown = true;
  expect(decodeMcpStdioProcessEvidence(unknown, binding, 100)).toEqual(unknown);
});

test('Linux formal transport preserves SDK discovery and full results, checks freshness at actual wire and retains first unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-linux-stdio-port-'));
  try {
    const guardian = join(root, 'guardian.js'),
      initExecutable = join(root, 'init'),
      bubblewrapPath = join(root, 'bwrap');
    for (const path of [guardian, initExecutable, bubblewrapPath]) writeFileSync(path, 'fixture');
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, 'linux-stdio-port.fixture.ts'),
        JSON.stringify({
          root,
          guardian,
          initExecutable,
          bubblewrapPath,
          proof: receipt(),
          binding,
        }),
      ],
      { timeout: 4000, encoding: 'utf8' },
    );
    if (result.status !== 0) console.error(result.stderr);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
