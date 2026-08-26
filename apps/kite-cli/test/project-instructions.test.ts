import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContextProjection,
  countTokens,
  formatProjectInstructionSnapshot,
  MAX_PROJECT_INSTRUCTION_TOKENS,
  resolveProjectInstructionSnapshot,
} from '@kite-ai/builtin-runtime/model';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type { AgentConfig } from '#kite-cli/config';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import {
  executeTestRuntimeTools,
  testRuntimeCapabilityExecutionPort,
} from '../../../tests/helpers/runtime-model';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-project-instructions-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project instruction snapshot', () => {
  test('orders parent CLAUDE before AGENTS and child scope last', () => {
    const root = workspace();
    mkdirSync(join(root, 'src', 'feature'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), 'root claude');
    writeFileSync(join(root, 'AGENTS.md'), 'root agents');
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'src agents');

    const snapshot = resolveProjectInstructionSnapshot({
      workspace: root,
      targetPaths: ['src/feature/index.ts'],
    });

    expect(snapshot.documents.map((document) => document.path)).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      'src/AGENTS.md',
    ]);
    const formatted = formatProjectInstructionSnapshot(snapshot);
    expect(formatted.indexOf('root claude')).toBeLessThan(formatted.indexOf('root agents'));
    expect(formatted.indexOf('root agents')).toBeLessThan(formatted.indexOf('src agents'));
    expect(formatted).toContain('cannot weaken system or runtime safety policy');
  });

  test('skips oversized and linked instruction files', () => {
    const root = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(16 * 1024 + 1));
    const outside = workspace();
    writeFileSync(join(outside, 'CLAUDE.md'), 'outside');
    try {
      symlinkSync(join(outside, 'CLAUDE.md'), join(root, 'CLAUDE.md'));
    } catch {
      // Some Windows test environments do not grant symlink creation.
    }

    const snapshot = resolveProjectInstructionSnapshot({ workspace: root });
    expect(snapshot.documents).toHaveLength(0);
    expect(snapshot.warnings.some((warning) => warning.includes('exceeds 16 KiB'))).toBe(true);
    if (snapshot.warnings.some((warning) => warning.includes('CLAUDE.md'))) {
      expect(snapshot.warnings.some((warning) => warning.includes('not a regular'))).toBe(true);
    }
  });

  test('ignores target paths outside the workspace', () => {
    const root = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'root only');
    const snapshot = resolveProjectInstructionSnapshot({
      workspace: root,
      targetPaths: ['../outside/file.ts'],
    });
    expect(snapshot.documents.map((document) => document.path)).toEqual(['AGENTS.md']);
  });

  test('reports and skips content beyond the project instruction token budget', () => {
    const root = workspace();
    let scope = root;
    for (const name of ['a', 'b', 'c', 'd']) {
      writeFileSync(join(scope, 'AGENTS.md'), '规则'.repeat(2500));
      scope = join(scope, name);
      mkdirSync(scope);
    }
    const snapshot = resolveProjectInstructionSnapshot({
      workspace: root,
      targetPaths: ['a/b/c/d/file.ts'],
    });
    expect(snapshot.warnings.some((warning) => warning.includes('token budget'))).toBe(true);
    expect(
      countTokens(snapshot.documents.map((document) => document.content).join('\n')),
    ).toBeLessThanOrEqual(MAX_PROJECT_INSTRUCTION_TOKENS);
  });

  test('projects refreshed instructions after the durable transcript and before runtime state', () => {
    const root = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'project rule');
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't',
      userId: 'u',
      workspace: root,
    });
    state.transcript.messages = [
      ...state.transcript.messages,
      {
        kind: 'user',
        messageId: 'm1',
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-18T00:00:00.000Z',
        content: 'current user request',
      },
    ];
    const snapshot = resolveProjectInstructionSnapshot({ workspace: root });
    const projection = buildContextProjection({
      role: 'agent',
      state,
      projectInstructions: snapshot,
      sandboxBackend: 'seatbelt',
    });
    const content = projection.providerMessages.map((message) => String(message.content));
    expect(content[0]).toContain('You are Kite');
    expect(content[1]).toContain('Cacheable runtime context:');
    expect(content[2]).toBe('current user request');
    expect(content[3]).toContain('project rule');
    expect(projection.providerMessages.slice(0, 4).map((message) => message.type)).toEqual([
      'system',
      'system',
      'human',
      'human',
    ]);
    expect(content.at(-1)).toContain('sandbox_backend: seatbelt');
  });

  test('loads nested instructions for a concrete file target in user transcript text', () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'AGENTS.md'), 'root rule');
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'nested rule');
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'thread-target',
      userId: 'user',
      workspace: root,
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'message-target',
      content: 'Please update src/new.ts after inspecting the current implementation.',
    });
    const snapshot = resolveProjectInstructionSnapshot({ workspace: root, state });
    expect(snapshot.documents.map((document) => document.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
    ]);
  });

  test('rejects an unseen nested instruction before Host and accepts a refreshed retry', async () => {
    const root = workspace();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'root rule');
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'nested rule');
    const createState = (visibleTarget: boolean) => {
      let state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0'.repeat(64),
        threadId: visibleTarget ? 'instruction-refreshed' : 'instruction-unseen',
        userId: 'user',
        workspace: root,
      });
      state.mode = 'accept_edits';
      if (visibleTarget) {
        state = reduceRuntimeState(state, {
          type: 'user.message_appended',
          messageId: 'prior-user-message',
          content: 'Update src/new.ts after reading its project instructions.',
        });
      }
      state.tools.calls.write = {
        toolCallId: 'write',
        modelMessageId: visibleTarget ? 'model-refreshed' : 'model-unseen',
        ordinal: 0,
        name: 'write_file',
        args: { path: 'src/new.ts', content: 'export {};' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'write'];
      return state;
    };
    const config = {
      apiKey: 'fixture',
      baseURL: 'https://example.invalid',
      providerName: 'fixture',
      modelName: 'fixture',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
    } as AgentConfig;
    const host = testRuntimeCapabilityExecutionPort();
    let hostCalls = 0;
    const capabilityExecution = Object.freeze({
      invoke: async (invocation: Parameters<typeof host.invoke>[0]) => {
        hostCalls += 1;
        return host.invoke(invocation);
      },
    });

    const rejected = await executeTestRuntimeTools({
      state: createState(false),
      toolCallIds: ['write'],
      taskConfig: config,
      capabilityExecution,
    });
    expect(rejected).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'write',
        reason: expect.stringContaining('project_instructions_changed'),
      }),
    );
    expect(
      rejected.filter(
        (event) =>
          event.type === 'capability.invocation_recorded' ||
          event.type === 'capability.execution_started',
      ),
    ).toEqual([]);
    expect(hostCalls).toBe(0);
    expect(existsSync(join(root, 'src', 'new.ts'))).toBe(false);

    const retried = await executeTestRuntimeTools({
      state: createState(true),
      toolCallIds: ['write'],
      taskConfig: config,
      capabilityExecution,
    });
    expect(retried.filter((event) => event.type === 'tool.rejected')).toEqual([]);
    expect(retried.filter((event) => event.type === 'tool.finished')).toHaveLength(1);
    expect(hostCalls).toBe(1);
    expect(existsSync(join(root, 'src', 'new.ts'))).toBe(true);
  });

  test('always runs the snapshot guard after the prompt contract clean cutover', async () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'AGENTS.md'), 'nested rule');
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'instruction-guard-disabled',
      userId: 'user',
      workspace: root,
    });
    state.mode = 'accept_edits';
    state.tools.calls.write = {
      toolCallId: 'write',
      modelMessageId: 'model-disabled',
      ordinal: 0,
      name: 'write_file',
      args: { path: 'src/disabled.ts', content: 'export {};' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'write'];
    const host = testRuntimeCapabilityExecutionPort();
    let hostCalls = 0;
    const events = await executeTestRuntimeTools({
      state,
      toolCallIds: ['write'],
      taskConfig: {
        apiKey: 'fixture',
        baseURL: 'https://example.invalid',
        providerName: 'fixture',
        modelName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      } as AgentConfig,
      capabilityExecution: Object.freeze({
        invoke: async (invocation: Parameters<typeof host.invoke>[0]) => {
          hostCalls += 1;
          return host.invoke(invocation);
        },
      }),
    });
    expect(events.filter((event) => event.type === 'tool.rejected')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.finished')).toEqual([]);
    expect(hostCalls).toBe(0);
    expect(existsSync(join(root, 'src', 'disabled.ts'))).toBe(false);
  });
});
