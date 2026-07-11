import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { runRuntimeAgent } from '@/core/runtime/agent';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createAgentKernel } from '@/core/runtime/kernel';
import { createRuntimeStore } from '@/core/runtime/store';
import { StreamingMockModel } from '../mock-model';

test('Runtime Kernel persists a direct model answer as a completed turn', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  const model = new StreamingMockModel({
    responses: [{ message: new AIMessage({ content: 'Kernel answer' }) }],
  });

  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runRuntimeAgent(
      {
        task: 'Say hello',
        threadId: 'kernel-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
        model: model as never,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event.type);
    }

    expect(events).toEqual([
      'user.message_appended',
      'turn.started',
      'model.requested',
      'model.responded',
      'run.completed',
      'turn.completed',
    ]);
    const store = createRuntimeStore(storePath);
    expect(store.loadEvents('kernel-integration').map((entry) => entry.event.type)).toEqual(events);
    store.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel executes a read tool before completing the answer', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  writeFileSync(join(workspace, 'note.txt'), 'runtime kernel');
  const model = new StreamingMockModel({
    responses: [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'read-note', name: 'read_file', args: { path: 'note.txt' } }],
      }),
      new AIMessage({ content: 'Read the note.' }),
    ].map((message) => ({ message })),
  });

  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runRuntimeAgent(
      {
        task: 'Read note.txt',
        threadId: 'kernel-tool-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
        model: model as never,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event.type);
    }

    expect(events).toContain('tool.queued');
    expect(events).toContain('tool.started');
    expect(events).toContain('tool.finished');
    expect(events.at(-2)).toBe('run.completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel rejects a write tool before a plan is approved', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  const model = new StreamingMockModel({
    responses: [
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'write-note', name: 'write_file', args: { path: 'note.txt', content: 'approved' } },
        ],
      }),
      new AIMessage({ content: 'Wrote the note.' }),
    ].map((message) => ({ message })),
  });

  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runRuntimeAgent(
      {
        task: 'Write note.txt',
        threadId: 'kernel-approval-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
        model: model as never,
        phase: 'planning',
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event.type);
    }

    expect(events).toContain('tool.rejected');
    expect(existsSync(join(workspace, 'note.txt'))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel resumes ask_user with the supplied RuntimeAction answer', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
  const model = new StreamingMockModel({
    responses: [
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'ask-name',
            name: 'ask_user',
            args: { question: 'What is your name?', options: [], allow_free_text: true },
          },
        ],
      }),
      new AIMessage({ content: 'Thanks for the answer.' }),
    ].map((message) => ({ message })),
  });

  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runRuntimeAgent(
      {
        task: 'Ask for a name',
        threadId: 'kernel-input-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: join(workspace, 'runtime.db'),
        model: model as never,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      {
        requestAction: async (effect) => ({
          type: 'input',
          interactionId: effect.interactionId,
          text: 'Ada',
        }),
      },
    ))
      events.push(event.type);

    expect(events).toContain('user_input.requested');
    expect(events).toContain('user_input.answered');
    expect(events).toContain('tool.finished');
    expect(events.at(-1)).toBe('turn.completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel executes an approved write after plan review', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
  const model = new StreamingMockModel({
    responses: [
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'plan-1',
            name: 'update_plan',
            args: {
              name: 'Write note',
              description: 'Create a note file',
              status: 'pending',
              steps: [{ step: 'Write note.txt', status: 'pending' }],
            },
          },
        ],
      }),
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'write-1',
            name: 'write_file',
            args: { path: 'note.txt', content: 'planned' },
          },
        ],
      }),
      new AIMessage({ content: 'Completed the plan.' }),
    ].map((message) => ({ message })),
  });
  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runRuntimeAgent(
      {
        task: 'Create note.txt',
        threadId: 'kernel-plan-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: join(workspace, 'runtime.db'),
        model: model as never,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      {
        requestAction: async (effect) =>
          effect.type === 'request_plan_review'
            ? { type: 'approve_plan', interactionId: effect.interactionId, executionMode: 'manual' }
            : { type: 'approve', interactionId: effect.interactionId, grant: 'approve_once' },
      },
    ))
      events.push(event.type);

    expect(events).toContain('plan.review_requested');
    expect(events).toContain('plan.approved');
    expect(events).toContain('approval.granted');
    expect(existsSync(join(workspace, 'note.txt'))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel restores a persisted snapshot when reopening the same thread', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  try {
    const first = createAgentKernel({
      threadId: 'kernel-recovery',
      userId: 'test',
      workspace,
      storePath,
    });
    first.processEvent({
      type: 'tool.queued',
      toolCallId: 'persisted-read',
      name: 'read_file',
      args: { path: 'note.txt' },
    });
    first.close();

    const restored = createAgentKernel({
      threadId: 'kernel-recovery',
      userId: 'test',
      workspace,
      storePath,
    });
    expect(restored.getState().tools.queue).toEqual(['persisted-read']);
    expect(restored.getState().tools.calls['persisted-read']?.status).toBe('queued');
    restored.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
