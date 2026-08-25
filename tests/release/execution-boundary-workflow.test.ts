import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(
  resolve('.github/workflows/execution-boundary-conformance.yml'),
  'utf8',
);
const keyringWorkflow = readFileSync(
  resolve('.github/workflows/mcp-native-keyring-smoke.yml'),
  'utf8',
);
const sessionLogWorkflow = readFileSync(
  resolve('.github/workflows/session-log-acl-smoke.yml'),
  'utf8',
);

describe('execution-boundary conformance workflow', () => {
  test('pins every third-party action to an immutable commit SHA', () => {
    const actionUses = [...workflow.matchAll(/^\s*- uses:\s+([^\s]+)\s*$/gmu)].map(
      (match) => match[1],
    );
    expect(actionUses).toHaveLength(3);
    for (const action of actionUses) {
      expect(action).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    }
    expect(actionUses).toEqual([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ]);
  });

  test('watches only current package and App owners', () => {
    for (const retired of ['src/core/', 'src/app/', 'src/protocol/']) {
      expect(workflow).not.toContain(retired);
      expect(keyringWorkflow).not.toContain(retired);
      expect(sessionLogWorkflow).not.toContain(retired);
    }
    expect(workflow).toContain('packages/builtin-runtime/src/sandbox/**');
    expect(workflow).toContain('packages/runtime-host/src/process/**');
    expect(workflow).toContain('apps/kite/src/config/execution-boundary.ts');
    expect(keyringWorkflow).toContain('packages/builtin-runtime/src/mcp/credential-store.ts');
    expect(sessionLogWorkflow).toContain('apps/kite/src/session-logger/**');
    expect(sessionLogWorkflow).toContain('apps/kite/src/config/paths.ts');
  });
});
