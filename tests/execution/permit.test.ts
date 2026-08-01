import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermitBatch } from '../../src/core/execution/permit';
import { hashToolApprovalRequest } from '../../src/core/harness/tool-policy';
import type { PendingToolRequest } from '../../src/core/harness/tool-requests';
import { runApprovedTool } from '../../src/core/harness/tool-runner';

function writeRequest(path = 'ok.txt', id = 'call-write'): PendingToolRequest {
  return {
    source: 'builtin',
    id,
    name: 'write_file',
    args: { path, content: 'hello' },
    reason: 'write',
    protectedCommand: `write_file ${path}`,
  };
}

describe('execution permits', () => {
  test('requires a matching unconsumed permit for protected tools', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-permit-'));
    const request = writeRequest();
    try {
      const permitBatch: PermitBatch = {
        'call-write': {
          grant: 'approve_once',
          argsHash: hashToolApprovalRequest({
            workspace,
            threadId: 'thread-1',
            request,
          }),
          consumed: false,
        },
      };

      const result = await runApprovedTool({
        workspace,
        threadId: 'thread-1',
        request,
        approvedGrant: 'approve_once',
        permitBatch,
      });

      expect(result.ok).toBe(true);
      expect(permitBatch['call-write']?.consumed).toBe(true);

      const repeated = await runApprovedTool({
        workspace,
        threadId: 'thread-1',
        request,
        approvedGrant: 'approve_once',
        permitBatch,
      });

      expect(repeated.ok).toBe(false);
      expect(repeated.status).toBe('rejected');
      expect(repeated.stderr).toContain('No valid permit');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('rejects execution when approved arguments changed', async () => {
    const approved = writeRequest('approved.txt');
    const changed = writeRequest('changed.txt');
    const permitBatch: PermitBatch = {
      'call-write': {
        grant: 'approve_once',
        argsHash: hashToolApprovalRequest({
          workspace: '/tmp/workspace',
          threadId: 'thread-1',
          request: approved,
        }),
        consumed: false,
      },
    };

    const result = await runApprovedTool({
      workspace: '/tmp/workspace',
      threadId: 'thread-1',
      request: changed,
      approvedGrant: 'approve_once',
      permitBatch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.stderr).toContain('arguments changed');
  });
});
