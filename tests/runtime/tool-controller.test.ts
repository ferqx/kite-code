import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRuntimeTools, toRuntimeSubagentEvent } from '@/core/controllers/tool-controller';
import { createInitialRuntimeState } from '@/core/runtime/state';

describe('executeRuntimeTools', () => {
  test('converts delegated lifecycle facts to the public RuntimeEvent protocol', () => {
    expect(
      toRuntimeSubagentEvent({
        type: 'start',
        data: { id: 'sub-1', role: 'explore', task: 'find callers' },
      }),
    ).toEqual({
      type: 'subagent.started',
      subagent: { id: 'sub-1', role: 'explore', task: 'find callers' },
    });
  });

  test('emits a rejection without executing a policy-denied tool', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-tool-policy',
      userId: 'user',
      workspace: process.cwd(),
      phase: 'planning',
    });
    state.tools.calls.denied = {
      toolCallId: 'denied',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'node -e "process.exit(0)"' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('denied');
    let executed = false;

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['denied'],
      shellExecutor: async () => {
        executed = true;
        return { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(executed).toBe(false);
    expect(events).toEqual([
      {
        type: 'tool.rejected',
        toolCallId: 'denied',
        reason: 'Rejected shell_execute during planning phase.',
      },
    ]);
  });

  test('finishes write_plan once and returns the persisted plan identity', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-plan-write',
      userId: 'user',
      workspace: process.cwd(),
      phase: 'planning',
    });
    state.tools.calls.write = {
      toolCallId: 'write',
      modelMessageId: 'model',
      name: 'write_plan',
      args: {
        title: 'Inspect runtime',
        body_markdown: 'Inspect the runtime lifecycle and verify every transition.',
        steps: [{ id: 'inspect-runtime', title: 'Inspect runtime lifecycle' }],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('write');

    const events = await executeRuntimeTools({ state, toolCallIds: ['write'] });

    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toBeDefined();
    if (finished?.type === 'tool.finished') {
      expect(finished.name).toBe('write_plan');
      expect(JSON.parse(finished.result.stdout)).toMatchObject({
        ok: true,
        status: 'draft_saved',
        version: 1,
      });
    }
  });

  test('cancels later sibling calls when write_plan action=submit opens review', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-plan-barrier',
      userId: 'user',
      workspace: process.cwd(),
      phase: 'planning',
    });
    const document = {
      planId: 'plan-1',
      version: 1,
      title: 'Inspect',
      bodyMarkdown: 'Inspect runtime state transitions in detail.',
      steps: [{ id: 'inspect', title: 'Inspect runtime', status: 'pending' as const }],
      structuralDigest: 'digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    };
    state.planning = { kind: 'planning_draft', document };
    state.tools.calls.submit = {
      toolCallId: 'submit',
      modelMessageId: 'message-1',
      ordinal: 0,
      name: 'write_plan',
      args: {
        title: 'Inspect',
        body_markdown: 'Inspect runtime state transitions in detail.',
        steps: [{ id: 'inspect', title: 'Inspect runtime' }],
        action: 'submit',
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.write = {
      toolCallId: 'write',
      modelMessageId: 'message-1',
      ordinal: 1,
      name: 'write_file',
      args: { path: 'unsafe.txt', content: 'unsafe' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('submit', 'write');

    const events = await executeRuntimeTools({ state, toolCallIds: ['submit'] });

    expect(events).toContainEqual({
      type: 'tool.cancelled',
      toolCallId: 'write',
      reason: 'Cancelled because an earlier tool call opened an interaction.',
    });
  });

  test('write_file in accept_edits mode bypasses approval and executes directly', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-accept-edits-write-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'runtime-accept-edits',
        userId: 'user',
        workspace,
      });
      state.mode = 'accept_edits';
      state.planning = {
        kind: 'executing',
        document: {
          planId: 'plan-approved',
          version: 1,
          title: 'Test',
          bodyMarkdown: 'Test plan.',
          steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
          structuralDigest: 'abc',
          createdAtTurnId: state.turn.turnId,
          updatedAtTurnId: state.turn.turnId,
        },
        executionMode: 'accept_edits',
        approvedAtTurnId: state.turn.turnId,
      };
      state.tools.calls.wf = {
        toolCallId: 'wf',
        modelMessageId: 'model',
        ordinal: 0,
        name: 'write_file',
        args: { path: 'test.txt', content: 'hello' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('wf');

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['wf'],
        shellExecutor: {
          execute: async (_command: string, _opts?: Record<string, unknown>) => {
            return {
              ok: true,
              command: 'write_file test.txt',
              exitCode: 0,
              stdout: '',
              stderr: '',
            };
          },
        } as never,
      });

      // Should NOT be rejected — accept_edits mode allows file edits without approval
      const rejected = events.find((e) => e.type === 'tool.rejected');
      expect(rejected).toBeUndefined();

      // Should complete successfully
      const finished = events.find((e) => e.type === 'tool.finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'tool.finished') {
        expect(finished.result.ok).toBe(true);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('edit_file in accept_edits mode bypasses approval and executes directly', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-accept-edits-edit-'));
    try {
      writeFileSync(join(workspace, 'test.txt'), 'old');
      const state = createInitialRuntimeState({
        threadId: 'runtime-accept-edits-edit',
        userId: 'user',
        workspace,
      });
      state.mode = 'accept_edits';
      state.planning = {
        kind: 'executing',
        document: {
          planId: 'plan-approved',
          version: 1,
          title: 'Test',
          bodyMarkdown: 'Test plan.',
          steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
          structuralDigest: 'abc',
          createdAtTurnId: state.turn.turnId,
          updatedAtTurnId: state.turn.turnId,
        },
        executionMode: 'accept_edits',
        approvedAtTurnId: state.turn.turnId,
      };
      state.tools.calls.ef = {
        toolCallId: 'ef',
        modelMessageId: 'model',
        ordinal: 0,
        name: 'edit_file',
        args: { path: 'test.txt', old_string: 'old', new_string: 'new' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('ef');

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['ef'],
        shellExecutor: {
          execute: async (_command: string, _opts?: Record<string, unknown>) => {
            return { ok: true, command: 'edit_file test.txt', exitCode: 0, stdout: '', stderr: '' };
          },
        } as never,
      });

      // edit_file should NOT be rejected by defense-in-depth — accept_edits mode bypasses approval
      const rejected = events.find((e) => e.type === 'tool.rejected');
      expect(rejected).toBeUndefined();

      // Tool should have been started (not blocked at defense-in-depth)
      const started = events.find((e) => e.type === 'tool.started');
      expect(started).toBeDefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('shell_execute in accept_edits mode still requires approval', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-accept-edits-shell',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    state.planning = {
      kind: 'executing',
      document: {
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    };
    state.tools.calls.sh = {
      toolCallId: 'sh',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'npm test' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('sh');

    const events = await executeRuntimeTools({ state, toolCallIds: ['sh'] });

    // shell_execute is NOT a file edit — should create an approval interaction
    const approvalRequested = events.find((e) => e.type === 'approval.requested');
    expect(approvalRequested).toBeDefined();

    // Should NOT have executed directly
    const finished = events.find((e) => e.type === 'tool.finished');
    expect(finished).toBeUndefined();
  });

  test('requires approval for a network read in accept_edits mode', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-accept-edits-network',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    state.tools.calls.fetch = {
      toolCallId: 'fetch',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'web_fetch',
      args: { url: 'https://example.com' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('fetch');

    const events = await executeRuntimeTools({ state, toolCallIds: ['fetch'] });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  test('auto-reviews a network read before execution in auto mode', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-auto-network',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'auto';
    state.tools.calls.fetch = {
      toolCallId: 'fetch',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'web_fetch',
      args: { url: 'https://example.com' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('fetch');

    const events = await executeRuntimeTools({ state, toolCallIds: ['fetch'] });

    expect(events.some((event) => event.type === 'auto_review.requested')).toBe(true);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  test('runs a proven workspace-only shell write directly in accept_edits mode', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-accept-edits-shell-write',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    state.planning = {
      kind: 'executing',
      document: {
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    };
    state.tools.calls.shell = {
      toolCallId: 'shell',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'touch policy-proof.txt' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('shell');

    let executed = false;
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['shell'],
      shellExecutor: async (input) => {
        executed = true;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(executed).toBe(true);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('requires approval for a Git mutation in accept_edits mode', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-accept-edits-local-git',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    state.planning = {
      kind: 'executing',
      document: {
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    };
    state.tools.calls.git = {
      toolCallId: 'git',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'git add policy-proof.txt' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('git');

    let executed = false;
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['git'],
      shellExecutor: async (input) => {
        executed = true;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(executed).toBe(false);
  });

  test('write_file in auto mode inherits accept_edits direct execution', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-auto-write-'));
    const state = createInitialRuntimeState({
      threadId: 'runtime-auto-write',
      userId: 'user',
      workspace,
    });
    state.mode = 'auto';
    state.planning = {
      kind: 'executing',
      document: {
        planId: 'plan-auto',
        version: 1,
        title: 'Auto',
        bodyMarkdown: 'Auto plan.',
        steps: [{ id: 's1', title: 'Step', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
      },
      executionMode: 'auto',
      approvedAtTurnId: state.turn.turnId,
    };
    state.tools.calls.wf = {
      toolCallId: 'wf',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'write_file',
      args: { path: 'test.txt', content: 'hello' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('wf');

    try {
      const events = await executeRuntimeTools({ state, toolCallIds: ['wf'] });

      expect(events.some((event) => event.type === 'auto_review.requested')).toBe(false);
      expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
      expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
      expect(readFileSync(join(workspace, 'test.txt'), 'utf8')).toBe('hello');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
