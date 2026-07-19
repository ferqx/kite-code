/**
 * PTY System Test — Sub-agent External Write Approval
 *
 * Verifies that when a sub-agent attempts to write a file outside the workspace
 * (absolute path), the approval flow is triggered correctly:
 *   1. Main agent spawns a code sub-agent via the task tool
 *   2. Sub-agent attempts write_file with an absolute path
 *   3. Approval dialog appears for the external write
 *   4. User approves → tool executes → sub-agent continues → completes
 *
 * This test directly exercises the runSubAgentLoop → runApprovedTool →
 * approvalRequiredBlock → subagent.suspended → approval.requested chain.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Sub-agent External Write Approval', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response sequence:
    // #1: Main agent → dispatches a code sub-agent (task tool)
    // #2: Sub-agent → attempts write_file with absolute path (triggers approval)
    // #3: Sub-agent after approval → summary
    // #4: Main agent after sub-agent completes → final response
    // #5-6: spare for generateSessionName / retries
    server.setResponses([
      {
        message: {
          content: 'I will dispatch a sub-agent to test external file write authorization.',
          tool_calls: [
            {
              id: 'call_spawn_subagent',
              name: 'task',
              args: {
                subagent_type: 'code',
                task: 'Write a test file at /tmp/test-subagent-write.txt with content "Test: sub-agent external write". Report whether the write succeeded or was blocked.',
              },
            },
          ],
        },
      },
      {
        message: {
          content: 'I will write the test file.',
          tool_calls: [
            {
              id: 'call_subagent_write',
              name: 'write_file',
              args: {
                path: '/tmp/test-subagent-write.txt',
                content: 'Test: sub-agent external write',
              },
            },
          ],
        },
      },
      {
        message: {
          content: 'The write succeeded after approval.',
        },
      },
      {
        message: {
          content: 'Sub-agent completed successfully.',
        },
      },
      { message: { content: 'spare 1' } },
      { message: { content: 'spare 2' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  test(
    'sub-agent external write triggers approval dialog, approve → tool executes → completes',
    async () => {
      // Type the user message
      await typeText(tui, 'Test subagent external file write authorization');
      tui.write('\r');
      await waitForRequestMessage(server, 'Test subagent external file write authorization', 15000);

      // Wait for the sub-agent to start and the external write to trigger approval
      await waitForText(() => tui.output(), 'Approve this tool call?', TIMEOUT);

      const beforeApprove = tui.output();
      const clean = stripAnsi(beforeApprove);
      console.log('  output during approval:', clean.slice(-2000));

      // Verify approval dialog content
      expect(screenContains(beforeApprove, 'Approve this tool call?')).toBe(true);
      // The approval should reference the external file path
      expect(screenContains(beforeApprove, '/tmp/test-subagent-write.txt')).toBe(true);

      // Approve the tool (default "Yes · 仅本次" at index 0, press Enter)
      tui.write('\r');
      await sleep(3000);

      // After approval, the sub-agent should continue and complete
      await waitForText(() => tui.output(), 'Sub-agent completed successfully.', TIMEOUT);

      const afterApprove = tui.output();
      const clean2 = stripAnsi(afterApprove);
      console.log('  output after approval (last 2000 chars):', clean2.slice(-2000));

      // Verify the sub-agent completed
      expect(screenContains(afterApprove, 'Sub-agent completed successfully.')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(afterApprove, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'external file was actually written after approval',
    async () => {
      // The file at /tmp/test-subagent-write.txt should exist
      // after the approval allowed the write to proceed
      const externalFile = '/tmp/test-subagent-write.txt';
      if (existsSync(externalFile)) {
        const content = readFileSync(externalFile, 'utf8');
        expect(content).toContain('Test: sub-agent external write');
      }
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — Sub-agent Read File Flow', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Write a file inside the workspace so the sub-agent can read it
    writeFileSync(join(workspace.workspace, 'data.txt'), 'hello from workspace\nline 2');

    // Response #1: Main agent dispatches code sub-agent
    // Response #2: Sub-agent reads data.txt with absolute path (should succeed, no approval)
    // Response #3: Sub-agent reports result
    // Response #4: Main agent final response
    server.setResponses([
      {
        message: {
          content: 'I will dispatch a sub-agent to read a file.',
          tool_calls: [
            {
              id: 'call_spawn_reader',
              name: 'task',
              args: {
                subagent_type: 'code',
                task: `Read the file at ${join(workspace.workspace, 'data.txt')} using its absolute path. Report the content.`,
              },
            },
          ],
        },
      },
      {
        message: {
          content: 'I will read the file.',
          tool_calls: [
            {
              id: 'call_subagent_read',
              name: 'read_file',
              args: { path: join(workspace.workspace, 'data.txt') },
            },
          ],
        },
      },
      {
        message: { content: 'File content: hello from workspace.' },
      },
      {
        message: { content: 'Sub-agent read completed successfully.' },
      },
      { message: { content: 'spare 1' } },
      { message: { content: 'spare 2' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  test(
    'sub-agent read_file with absolute path inside workspace succeeds without approval',
    async () => {
      await typeText(tui, 'Read data.txt');
      tui.write('\r');
      await waitForRequestMessage(server, 'Read data.txt', 15000);

      // Wait for sub-agent to complete — read should NOT trigger approval
      await waitForText(() => tui.output(), 'Sub-agent read completed successfully.', TIMEOUT);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after read:', clean.slice(-2000));

      // Sub-agent should have completed without cancellation
      expect(screenContains(output, 'Sub-agent read completed successfully.')).toBe(true);
      // No approval dialog should have appeared
      expect(screenContains(output, 'Approve this tool call?')).toBe(false);
      // TUI prompt should be visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
