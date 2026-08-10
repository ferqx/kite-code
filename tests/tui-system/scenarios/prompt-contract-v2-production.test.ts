/**
 * Production-mode Prompt Contract V2 PTY boundary.
 *
 * Launches the real TUI composition root with NODE_ENV=production and enables
 * V2 only through the normal layered config. The outbound HTTP request is the
 * evidence boundary for prompt roles, project instructions, runtime state and
 * phase-aware tool disclosure.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30_000;
const PROJECT_MARKER = 'V2 production PTY project instruction marker.';

function parseDraftSavedPlan(content: unknown): {
  plan_id: string;
  version: number;
  structural_digest: string;
} {
  const value: unknown = JSON.parse(String(content));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('plan_id' in value) ||
    typeof value.plan_id !== 'string' ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !('structural_digest' in value) ||
    typeof value.structural_digest !== 'string'
  ) {
    throw new Error('write_plan draft_saved result did not contain a valid plan identity');
  }
  return {
    plan_id: value.plan_id,
    version: value.version,
    structural_digest: value.structural_digest,
  };
}

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
        features: { promptContractV2: true },
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
              toolResults: [{ toolCallId: 'v2-plan-save', contentIncludes: ['draft_saved'] }],
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
      {
        response(request) {
          const result = request.messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'v2-plan-submit',
          );
          const plan = parseDraftSavedPlan(result?.content);
          return {
            expectedRequest: {
              toolResults: [
                { toolCallId: 'v2-plan-submit', contentIncludes: ['"status":"approved"'] },
              ],
            },
            message: {
              tool_calls: [
                {
                  id: 'v2-plan-complete',
                  name: 'update_plan',
                  args: {
                    plan_id: plan.plan_id,
                    version: plan.version,
                    structural_digest: plan.structural_digest,
                    updates: [{ step_id: 'inspect', status: 'completed' }],
                    complete_plan: true,
                  },
                },
              ],
            },
          };
        },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'v2-plan-complete', contentIncludes: ['"plan_completed":true'] },
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
    'projects V2 layers and the read-only planning tool surface through the real TUI',
    async () => {
      tui.write('\x1b[Z');
      await waitForText(() => tui.viewport(), 'Shift+Tab to exit', 5_000);

      const userPrompt = 'Inspect the project rules and propose a plan.';
      await submitUserMessage(tui, server, userPrompt, { timeout: 15_000 });
      await waitForText(() => tui.viewport(), '方案审核', 15_000);
      tui.write('\r');
      await waitForText(() => tui.viewport(), 'Production V2 request completed.', 15_000);
      expect(screenContains(tui.viewport(), 'Production V2 request completed.')).toBe(true);

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
      expect(userIndex).toBeGreaterThan(projectIndex);
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

      const tools = Array.isArray(request!.body.tools)
        ? (request!.body.tools as Array<{
            function?: {
              name?: string;
              description?: string;
              parameters?: {
                properties?: {
                  subagent_type?: { description?: string; enum?: string[] };
                };
              };
            };
          }>)
        : [];
      const toolNames = tools.map((tool) => tool.function?.name).filter(Boolean);
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('write_plan');
      expect(toolNames).not.toContain('edit_file');
      expect(toolNames).not.toContain('write_file');
      expect(toolNames).not.toContain('shell_execute');
      expect(
        tools.find((tool) => tool.function?.name === 'read_file')?.function?.description,
      ).toContain('Returns text:');
      const task = tools.find((tool) => tool.function?.name === 'task')?.function;
      expect(task?.description).toContain('current user explicitly requests');
      expect(task?.description).toContain('use plan for read-only architecture or design planning');
      expect(task?.parameters?.properties?.subagent_type?.enum).toEqual(['explore', 'plan']);
      expect(task?.parameters?.properties?.subagent_type?.description).toContain(
        'plan for architecture',
      );
    },
    TIMEOUT,
  );
});
