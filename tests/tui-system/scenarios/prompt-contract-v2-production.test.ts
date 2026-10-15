/**
 * Production-mode Prompt Contract V2 PTY boundary.
 *
 * Launches the real TUI composition root with NODE_ENV=production and uses
 * the default V2 feature profile. The outbound HTTP request is the
 * evidence boundary for prompt roles, project instructions, runtime state and
 * phase-stable tool disclosure plus Runtime-owned phase policy.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { currentPlanWorkResponses } from '../harness/current-plan';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer, parseDraftSavedPlan } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedTurnEvents,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const TIMEOUT = 30_000;
const PROJECT_MARKER = 'V2 production PTY project instruction marker.';

describe('TUI PTY System — production Prompt Contract V2', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      files: { 'AGENTS.md': PROJECT_MARKER },
      configOverrides: {
        sandbox: { enabled: false },
      },
    });
    workspace.env.CI = 'true';
    workspace.env.NODE_ENV = 'production';
    server.setResponses([
      {
        message: {
          tool_calls: [
            {
              id: 'v2-plan-save',
              name: 'write_plan',
              args: {
                action: 'save',
                title: 'Inspect project rules',
                body_markdown:
                  'Inspect the project instructions and validate the planning workflow.',
                steps: [{ id: 'inspect', title: 'Inspect project instructions' }],
              },
            },
          ],
        },
      },
      {
        response(request) {
          const result = request.messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'v2-plan-save',
          );
          const { plan_id, version, structural_digest } = parseDraftSavedPlan(result?.content);
          return {
            expectedRequest: {
              toolResults: [
                {
                  toolCallId: 'v2-plan-save',
                  contentIncludes: ['"planId"', '"version"', '"digest"'],
                },
              ],
            },
            message: {
              tool_calls: [
                {
                  id: 'v2-plan-submit',
                  name: 'write_plan',
                  args: { action: 'submit', plan_id, version, structural_digest },
                },
              ],
            },
          };
        },
      },
      ...currentPlanWorkResponses('v2-plan-submit', ['inspect'], {
        kind: 'read',
        path: 'AGENTS.md',
      }),
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'v2-plan-submit-progress-0', contentIncludes: ['"completePlan":true'] },
          ],
        },
        message: { content: 'Production V2 request completed.' },
      },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'projects V2 layers and a phase-stable tool surface through the real TUI',
    async () => {
      tui.write('\x1b[Z');
      await waitForText(() => tui.viewport(), 'Shift+Tab 退出计划模式', 5_000);

      const userPrompt = 'Inspect the project rules and propose a plan.';
      await submitUserMessage(tui, server, userPrompt, { timeout: 15_000 });
      await waitForText(() => tui.viewport(), '方案审核', 15_000);
      // The current review starts unselected; choose the explicit Accept Edits mode.
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 1. 在 Auto 模式下开始执行', 5_000);
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 2. 在接受编辑模式下开始执行', 5_000);
      tui.write('\r');
      await waitForText(() => tui.viewport(), 'Production V2 request completed.', 15_000);
      expect(screenContains(tui.viewport(), 'Production V2 request completed.')).toBe(true);

      await waitForCondition(
        () => {
          const observed = observePersistedTurnEvents(workspace, userPrompt);
          return (
            observed.status === 'ready' &&
            observed.value?.events.some(
              (event) => event.type === 'run.finished' && event.status === 'completed',
            ) === true
          );
        },
        'actual production planning Run completed',
        10_000,
      );
      const actual = requirePersistedRuntimeReady(
        observePersistedTurnEvents(workspace, userPrompt),
      );
      expect(actual).toBeDefined();
      expect(actual!.events.filter((event) => event.type === 'run.finished')).toEqual([
        expect.objectContaining({ type: 'run.finished', status: 'completed' }),
      ]);
      expect(server.getRequestCount()).toBe(6);
      const request = server.getRequests()[0];
      expect(request).toBeDefined();
      const messages = request!.messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : '',
      }));
      const systemMessages = messages.filter((message) => message.role === 'system');
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]!.content).toContain('# Instruction order');
      expect(systemMessages[0]!.content).toContain('Cacheable runtime context:');

      const projectIndex = messages.findIndex((message) =>
        message.content.includes(PROJECT_MARKER),
      );
      const userIndex = messages.findIndex((message) => message.content === userPrompt);
      expect(projectIndex).toBeGreaterThan(systemMessages.length - 1);
      expect(projectIndex).toBeGreaterThan(userIndex);
      expect(messages[projectIndex]!.role).toBe('user');
      expect(messages[projectIndex]!.content).toContain(
        '<project-instructions role="workspace-context">',
      );

      const runtimeMessages = messages.filter((message) =>
        message.content.includes('<runtime-state source="runtime.kernel">'),
      );
      expect(runtimeMessages).toHaveLength(1);
      expect(runtimeMessages[0]!.role).toBe('user');
      expect(runtimeMessages[0]!.content).toContain('phase: planning');
      expect(messages.at(-1)?.content).toBe(runtimeMessages[0]!.content);
      const approved = server.getRequests()[2]!;
      expect(approved.body.tools).toEqual(request!.body.tools);
      expect(approved.messages.filter((message) => message.role === 'system')).toEqual(
        request!.messages.filter((message) => message.role === 'system'),
      );
      expect(String(approved.messages.at(-1)?.content)).toContain('phase: building');
      expect(
        server
          .getRequests()
          .flatMap((item) => item.messages)
          .some(
            (message) =>
              message.role === 'tool' &&
              message.tool_call_id === 'v2-plan-submit-work-0' &&
              String(message.content).includes(PROJECT_MARKER),
          ),
      ).toBe(true);

      const tools = Array.isArray(request!.body.tools)
        ? (request!.body.tools as Array<{
            function?: {
              name?: string;
              description?: string;
              parameters?: {
                properties?: {
                  role?: { description?: string; enum?: string[] };
                };
              };
            };
          }>)
        : [];
      const toolNames = tools.map((tool) => tool.function?.name).filter(Boolean);
      expect(toolNames).toContain('files.read');
      expect(toolNames).toContain('planning.write');
      expect(toolNames).toContain('files.edit');
      expect(toolNames).toContain('files.write');
      expect(toolNames).toContain('shell.execute');
      expect(
        tools.find((tool) => tool.function?.name === 'files.read')?.function?.description,
      ).toContain('complete bodies or explicit immutable Artifact references');
      const task = tools.find((tool) => tool.function?.name === 'task.execute')?.function;
      expect(task?.description).toContain('benefits from an isolated sub-agent');
      expect(task?.description).toContain('code only when the user task calls for implementation');
      expect(task?.description).toContain('plan for read-only architecture or design planning');
      expect(task?.description).toContain('multiple independent sibling task calls');
      expect(task?.description).toContain('execute them concurrently');
      expect(task?.parameters?.properties?.role?.enum).toEqual([
        'worker',
        'code',
        'explore',
        'plan',
        'review',
      ]);
      expect(task?.parameters?.properties?.role?.description).toContain('Type of sub-agent');
    },
    TIMEOUT,
  );
});
