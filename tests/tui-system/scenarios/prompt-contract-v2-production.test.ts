/**
 * Production-mode Prompt Contract V2 PTY boundary.
 *
 * Launches the real TUI composition root with NODE_ENV=production and uses
 * the default V2 feature profile. The outbound HTTP request is the
 * evidence boundary for prompt roles, project instructions, runtime state and
 * stable tool disclosure across Runtime-owned plan approval.
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
          tool_calls: [{ id: 'v2-project-read', name: 'read_file', args: { path: 'AGENTS.md' } }],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'v2-project-read', contentIncludes: [PROJECT_MARKER] }],
        },
        message: {
          tool_calls: [
            {
              id: 'v2-plan-save',
              name: 'write_plan',
              args: {
                action: 'save',
                title: 'Inspect project rules',
                body_markdown:
                  'Record the inspection of the project instructions in the fixture workspace.',
                steps: [{ id: 'record', title: 'Record the project instruction inspection' }],
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
      ...currentPlanWorkResponses('v2-plan-submit', ['record']),
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
    'projects V2 layers and stable tools across plan approval through the real TUI',
    async () => {
      tui.write('\x1b[Z');
      await waitForText(() => tui.viewport(), 'Shift+Tab 退出计划模式', 5_000);

      const userPrompt = 'Inspect the project rules and propose a plan to record your review.';
      await submitUserMessage(tui, server, userPrompt, { timeout: 15_000 });
      await waitForText(() => tui.viewport(), '批准此计划', 15_000);
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 1. 批准此计划', 5_000);
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
      expect(server.getWorkRequestCount()).toBe(7);
      const request = server.getWorkRequests()[0];
      expect(request).toBeDefined();
      const messages = request!.messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : '',
      }));
      const systemMessages = messages.filter((message) => message.role === 'system');
      const sharedInstructions = systemMessages.filter((message) =>
        message.content.startsWith('# Task execution and evidence'),
      );
      expect(sharedInstructions).toHaveLength(1);
      expect(sharedInstructions[0]!.content).toContain('# Authority');
      expect(sharedInstructions[0]!.content).toContain(
        'Obtain explicit user approval before changing model-facing system instructions',
      );
      expect(sharedInstructions[0]!.content).toContain('# Working environment\nWorkspace root:');
      expect(systemMessages.some((message) => message.content.includes(PROJECT_MARKER))).toBe(
        false,
      );

      const projectIndex = messages.findIndex((message) =>
        message.content.includes(PROJECT_MARKER),
      );
      const userIndex = messages.findIndex((message) => message.content === userPrompt);
      expect(projectIndex).toBeGreaterThan(systemMessages.length - 1);
      expect(messages[projectIndex]!.role).toBe('user');
      expect(messages[projectIndex]!.content).toContain(
        '<project-instructions role="workspace-context">',
      );

      const runtimeIndex = messages.findIndex((message) =>
        message.content.startsWith('<runtime-state source="runtime.kernel">'),
      );
      expect(runtimeIndex).toBeGreaterThan(projectIndex);
      expect(userIndex).toBeGreaterThan(runtimeIndex);
      expect(messages[runtimeIndex]).toMatchObject({
        role: 'user',
        content: expect.stringContaining('plan_requirement: {"status":"pending"}'),
      });
      const approved = server.getWorkRequests()[3]!;
      expect(approved.body.tools).toEqual(request!.body.tools);
      expect(approved.messages.filter((message) => message.role === 'system')).toEqual(
        request!.messages.filter((message) => message.role === 'system'),
      );
      const approvedRuntime = approved.messages.find(
        (message) =>
          message.role === 'user' &&
          String(message.content).startsWith('<runtime-state source="runtime.kernel">'),
      );
      expect(String(approvedRuntime?.content)).toMatch(/plan_requirement: \{.*"status":"approved"/);
      expect(
        server
          .getWorkRequests()
          .flatMap((item) => item.messages)
          .some(
            (message) =>
              message.role === 'tool' &&
              message.tool_call_id === 'v2-project-read' &&
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
                  preset?: { description?: string; enum?: string[] };
                };
              };
            };
          }>)
        : [];
      const toolNames = tools.map((tool) => tool.function?.name).filter(Boolean);
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('write_plan');
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('shell_execute');
      const readFile = tools.find((tool) => tool.function?.name === 'read_file')?.function;
      expect(readFile?.description).toContain('start_line');
      expect(readFile?.description).toContain('next_line');
      const task = tools.find((tool) => tool.function?.name === 'spawn_agent')?.function;
      expect(task?.description).toContain('Delegate a concrete scoped prompt');
      expect(task?.parameters?.properties?.preset?.enum).toEqual(['general', 'explore']);
      expect(task?.parameters?.properties?.preset?.description).toContain(
        'Optional trusted preset',
      );
    },
    TIMEOUT,
  );
});
