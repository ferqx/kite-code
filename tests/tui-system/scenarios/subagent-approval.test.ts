/**
 * PTY System Test — Sub-agent External Write Approval
 *
 * Verifies that when a sub-agent attempts to write a file outside the workspace
 * (an absolute path outside the workspace), the approval flow is triggered correctly:
 *   1. Main agent spawns a code sub-agent via the task tool
 *   2. Sub-agent attempts write_file with an absolute path
 *   3. Approval dialog appears for the external write
 *   4. User approves → tool executes → sub-agent continues → completes
 *
 * This test directly exercises the runSubAgentLoop → invokeGovernedTool →
 * approvalRequiredBlock → subagent.suspended → approval.requested chain.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Sub-agent External Write Approval', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let externalFile: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        interactionMode: 'accept_edits',
      },
    });
    externalFile = join(workspace.home, 'external-subagent-write.txt');

    // Response sequence:
    // #1: Main agent → dispatches a code sub-agent (task tool)
    // #2: Sub-agent → attempts write_file with absolute path (triggers approval)
    // #3: Sub-agent after approval → summary
    // #4: Main agent after sub-agent completes → final response
    server.setResponses([
      {
        message: {
          content: 'I will dispatch a sub-agent to test external file write authorization.',
          tool_calls: [
            {
              id: 'call_spawn_subagent',
              name: 'task',
              args: {
                name: 'Write external test file',
                subagent_type: 'code',
                task: `Write a test file at ${externalFile} with content "Test: sub-agent external write". Report whether the write succeeded or was blocked.`,
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
                path: externalFile,
                content: 'Test: sub-agent external write',
              },
            },
          ],
        },
      },
      {
        // Keep the resumed child alive long enough to assert that the local
        // approval acknowledgement updates its card before the next model
        // response or durable child progress can do so incidentally.
        delay: 750,
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_subagent_write', contentIncludes: ['external-subagent-write.txt'] },
          ],
        },
        message: {
          content: 'The write succeeded after approval.',
        },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_spawn_subagent', contentIncludes: ['write succeeded'] },
          ],
        },
        message: {
          content: 'Sub-agent completed successfully.',
        },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  step(
    'sub-agent external write triggers approval dialog, approve → tool executes → completes',
    async () => {
      // Type the user message
      await submitUserMessage(tui, server, 'Test subagent external file write authorization', {
        timeout: 15000,
      });

      // Wait for the sub-agent to start and the external write to trigger approval
      await waitForText(() => tui.viewport(), '工具授权', TIMEOUT);

      const beforeApprove = tui.viewport();
      const clean = stripAnsi(beforeApprove);
      console.log('  output during approval:', clean.slice(-2000));

      // Verify approval dialog content
      expect(screenContains(beforeApprove, '工具授权')).toBe(true);
      expect(screenContains(beforeApprove, '等待你的批准')).toBe(true);
      // The terminal truncates long absolute paths to fit the viewport. Prove
      // the fixture target is external separately, then assert the stable file
      // identity that remains visible in the approval card.
      expect(externalFile.startsWith(workspace.workspace)).toBe(false);
      expect(screenContains(beforeApprove, 'external-subagent-write')).toBe(true);
      expect(existsSync(externalFile)).toBe(false);

      // Approve the tool (default "允许一次" at index 0, press Enter)
      tui.write('\r');

      // The optimistic `approving` projection may be shorter than one Ink
      // frame.  Require the first canonical post-grant child state instead:
      // either the durable authorized queue acknowledgement or its immediate
      // running successor.
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            !screenContains(viewport, '等待你的批准') &&
            !screenContains(viewport, '工具授权') &&
            (screenContains(viewport, '已授权 · 等待执行') || screenContains(viewport, '执行中'))
          );
        },
        'exact child approval to leave the human queue after its durable acknowledgement',
        TIMEOUT,
      );
      const acknowledged = tui.viewport();
      expect(screenContains(acknowledged, '等待你的批准')).toBe(false);
      expect(screenContains(acknowledged, '工具授权')).toBe(false);

      // After approval, the sub-agent should continue and complete
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Sub-agent completed successfully.',
        TIMEOUT,
      );

      const afterApprove = tui.viewport();
      const clean2 = stripAnsi(afterApprove);
      console.log('  output after approval (last 2000 chars):', clean2.slice(-2000));

      // Verify the sub-agent completed
      expect(screenContains(afterApprove, 'Sub-agent completed successfully.')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(afterApprove, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'external file was actually written after approval',
    async () => {
      expect(existsSync(externalFile)).toBe(true);
      const content = readFileSync(externalFile, 'utf8');
      expect(content).toContain('Test: sub-agent external write');
    },
    TIMEOUT,
  );
  test(
    'runs the complete external-write approval journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});

describe('TUI PTY System — Sub-agent Automatic Review', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let externalFile: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        interactionMode: 'auto',
        sandbox: { enabled: false },
      },
    });
    externalFile = join(workspace.home, 'auto-reviewed-subagent-write.txt');

    server.setResponses([
      {
        message: {
          content: 'I will delegate this external write.',
          tool_calls: [
            {
              id: 'call_spawn_auto_reviewed_subagent',
              name: 'task',
              args: {
                name: 'Write auto-reviewed file',
                subagent_type: 'code',
                task: `Write "auto review succeeded" to ${externalFile}.`,
              },
            },
          ],
        },
      },
      {
        message: {
          content: 'I will write the requested file.',
          tool_calls: [
            {
              id: 'call_auto_reviewed_write',
              name: 'write_file',
              args: {
                path: externalFile,
                content: 'auto review succeeded',
              },
            },
          ],
        },
      },
      {
        response: ({ messages }) => {
          const reviewRequest = String(messages.at(-1)?.content ?? '');
          expect(reviewRequest).toContain('Use a subagent to perform the external fixture write');
          expect(reviewRequest).toContain('"workspaceRoot"');
          expect(reviewRequest).toContain(
            workspace.workspace.slice(workspace.workspace.lastIndexOf('/') + 1),
          );
          expect(reviewRequest).toContain('"isSubAgent": true');
          expect(reviewRequest).toContain('"subAgentRole": "code"');
          return {
            // Keep the reviewer request in flight long enough to assert the transient TUI state.
            delay: 750,
            message: {
              content: JSON.stringify({
                decision: 'approve_once',
                reason: 'The requested fixture write is scoped and reversible.',
                riskAssessment: 'low',
              }),
            },
          };
        },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_auto_reviewed_write',
              contentIncludes: ['auto-reviewed-subagent-write.txt'],
            },
          ],
        },
        message: { content: 'The automatically reviewed write succeeded.' },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_spawn_auto_reviewed_subagent',
              contentIncludes: ['automatically reviewed write succeeded'],
            },
          ],
        },
        message: { content: 'Automatic sub-agent review completed successfully.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'auto review is visible, resumes the child, and never asks the user to approve',
    async () => {
      await submitUserMessage(tui, server, 'Use a subagent to perform the external fixture write', {
        timeout: 15000,
      });

      await waitForText(() => tui.viewport(), '自动审查中', TIMEOUT);
      const duringReview = tui.viewport();
      expect(screenContains(duringReview, '自动审查中')).toBe(true);
      expect(screenContains(duringReview, '工具授权')).toBe(false);
      expect(screenContains(duringReview, '等待你的批准')).toBe(false);

      await waitForText(
        () => tui.outputSinceLastAction(),
        'Automatic sub-agent review completed successfully.',
        TIMEOUT,
      );

      const completed = tui.viewport();
      expect(screenContains(completed, 'Automatic sub-agent review completed successfully.')).toBe(
        true,
      );
      expect(screenContains(completed, '❯')).toBe(true);
      expect(existsSync(externalFile)).toBe(true);
      expect(readFileSync(externalFile, 'utf8')).toContain('auto review succeeded');
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

    // Response #1: Main agent dispatches an explore sub-agent for the read-only task
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
                name: 'Read workspace data file',
                subagent_type: 'explore',
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
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_subagent_read', contentIncludes: ['hello from workspace'] },
          ],
        },
        message: { content: 'File content: hello from workspace.' },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_spawn_reader', contentIncludes: ['hello from workspace'] },
          ],
        },
        message: { content: 'Sub-agent read completed successfully.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'sub-agent read_file with absolute path inside workspace succeeds without approval',
    async () => {
      await submitUserMessage(tui, server, 'Use an explore subagent to inspect data.txt', {
        timeout: 15000,
      });

      // Wait for sub-agent to complete — read should NOT trigger approval
      try {
        await waitForText(
          () => tui.outputSinceLastAction(),
          'Sub-agent read completed successfully.',
          TIMEOUT - 5000,
        );
      } catch (error) {
        console.log('  output after read timeout:', stripAnsi(tui.viewport()).slice(-4000));
        console.log(
          '  model requests after read timeout:',
          server.getRequests().map((request) => request.messages.at(-1)),
        );
        throw error;
      }

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after read:', clean.slice(-2000));

      // Sub-agent should have completed without cancellation
      expect(screenContains(output, 'Sub-agent read completed successfully.')).toBe(true);
      // No approval dialog should have appeared
      expect(screenContains(output, '工具授权')).toBe(false);
      // TUI prompt should be visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
