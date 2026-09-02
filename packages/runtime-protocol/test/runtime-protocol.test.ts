import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import {
  decodeRuntimeProtocolMessage,
  generateRuntimeProtocolArtifactDigest,
  generateRuntimeProtocolArtifacts,
  generateRuntimeProtocolTypeScript,
  mapProtocolCommandToRuntimeCommand,
  mapRuntimeAccessNotificationToSubscriptionMessage,
  mapRuntimeClientEventToProtocol,
  mapRuntimeCommandToProtocol,
  mapRuntimeNotificationToSubscriptionMessage,
  mapRuntimeQueryResultToProtocol,
  mapRuntimeQueryToProtocol,
  mapSubscriptionMessageToClientUpdate,
  RUNTIME_PROTOCOL_EVENT_SCHEMA_,
  RUNTIME_PROTOCOL_LIMITS,
  RUNTIME_PROTOCOL_MESSAGE_SCHEMA_,
  RUNTIME_PROTOCOL_RESPONSE_SCHEMA_,
  RUNTIME_PROTOCOL_RESULT_SCHEMA_,
  RUNTIME_PROTOCOL_SESSION_SCHEMA_,
  RUNTIME_SUBSCRIPTION_MESSAGE_SCHEMA_,
  safeDecodeRuntimeProtocolMessage,
} from '../src/index';

const initializeRequest = {
  jsonrpc: '2.0',
  id: 'rpc-1',
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientInfo: { name: 'test', version: '1.0.0', instanceId: 'client-1' },
  },
};

describe('Runtime Protocol', () => {
  test('decodes the stable initialize fixture and preserves it on re-encode', async () => {
    const fixture = await Bun.file(
      new URL('../fixtures/valid-initialize-request.json', import.meta.url),
    ).json();
    const decoded = decodeRuntimeProtocolMessage(fixture);
    expect(JSON.parse(JSON.stringify(decoded))).toEqual(fixture);
  });

  test('rejects all malformed JSON-RPC shapes before routing', () => {
    expect(safeDecodeRuntimeProtocolMessage([initializeRequest]).success).toBeFalse();
    expect(
      safeDecodeRuntimeProtocolMessage({ ...initializeRequest, extra: true }).success,
    ).toBeFalse();
    expect(
      safeDecodeRuntimeProtocolMessage({ ...initializeRequest, jsonrpc: '1.0' }).success,
    ).toBeFalse();
    expect(safeDecodeRuntimeProtocolMessage({ ...initializeRequest, id: 1 }).success).toBeFalse();
    expect(
      safeDecodeRuntimeProtocolMessage({
        ...initializeRequest,
        params: { ...initializeRequest.params, protocolVersion: 2 },
      }).success,
    ).toBeFalse();
  });

  test('fails closed for unsafe, oversized, deep, and prototype-shaped input', () => {
    const unsafe = structuredClone(initializeRequest) as typeof initializeRequest & {
      params: {
        protocolVersion: number;
        clientInfo: { name: string; version: string; instanceId: string };
      };
    };
    unsafe.params.protocolVersion = Number.MAX_SAFE_INTEGER + 1;
    expect(safeDecodeRuntimeProtocolMessage(unsafe).success).toBeFalse();

    const oversized = structuredClone(initializeRequest) as typeof initializeRequest;
    oversized.params.clientInfo.name = 'x'.repeat(RUNTIME_PROTOCOL_LIMITS.maxMessageBytes);
    expect(safeDecodeRuntimeProtocolMessage(oversized).success).toBeFalse();

    let deep: unknown = 'terminal';
    for (let index = 0; index <= RUNTIME_PROTOCOL_LIMITS.maxDepth; index += 1)
      deep = { child: deep };
    expect(safeDecodeRuntimeProtocolMessage(deep).success).toBeFalse();
    expect(safeDecodeRuntimeProtocolMessage(JSON.parse('{"__proto__": {}}')).success).toBeFalse();
  });

  test('uses a closed command mapper and injects App-owned workspace only at the seam', () => {
    const wire = {
      schema: 'kite.runtime-command.v1' as const,
      commandId: 'command-1',
      type: 'create_session' as const,
      bootstrapSessionId: 'session-bootstrap',
    };
    const command = mapProtocolCommandToRuntimeCommand(wire, { workspace: '/not-on-the-wire' });
    expect(command).toEqual({ ...wire, workspace: '/not-on-the-wire' });
    expect(mapRuntimeCommandToProtocol(command)).toEqual(wire);
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-2',
        method: 'runtime/command',
        params: { command: { ...wire, unexpected: true } },
      }).success,
    ).toBeFalse();
    const inputCancelCommand = {
      schema: 'kite.runtime-command.v1' as const,
      commandId: 'command-input-cancel',
      type: 'respond_interaction',
      sessionId: 'session-1',
      expectedRevision: 7,
      interaction: {
        kind: 'input',
        interactionId: 'input-1',
        sessionRevision: 7,
        question: 'Continue?',
        allowFreeText: true,
      },
      response: { kind: 'input_cancel' },
    };
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-input-cancel',
        method: 'runtime/command',
        params: { command: inputCancelCommand },
      }).success,
    ).toBeTrue();
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-input-cancel-mismatch',
        method: 'runtime/command',
        params: {
          command: {
            ...inputCancelCommand,
            interaction: {
              kind: 'approval',
              interactionId: 'approval-1',
              sessionRevision: 7,
              generation: 1,
              grants: ['approve_once'],
            },
          },
        },
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-input-cancel-extra',
        method: 'runtime/command',
        params: {
          command: { ...inputCancelCommand, response: { kind: 'input_cancel', value: '' } },
        },
      }).success,
    ).toBeFalse();
    const clearGrants = {
      schema: 'kite.runtime-command.v1' as const,
      commandId: 'command-clear-grants',
      type: 'clear_session_command_grants' as const,
      sessionId: 'session-1',
      expectedRevision: 7,
    };
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-clear-grants',
        method: 'runtime/command',
        params: { command: clearGrants },
      }).success,
    ).toBeTrue();
    expect(
      mapProtocolCommandToRuntimeCommand(clearGrants, { workspace: '/not-on-the-wire' }),
    ).toEqual(clearGrants);
  });

  test('keeps interaction identity paired with its matching response and supports bounded initial skills', () => {
    const command = {
      schema: 'kite.runtime-command.v1',
      commandId: 'command-2',
      type: 'respond_interaction',
      sessionId: 'session-1',
      expectedRevision: 7,
      interaction: {
        kind: 'approval',
        interactionId: 'interaction-1',
        sessionRevision: 7,
        generation: 2,
        grants: ['approve_once'],
        command: 'git status --short --branch',
      },
      response: { kind: 'approval', decision: 'approve_once' },
    };
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-3',
        method: 'runtime/command',
        params: { command },
      }).success,
    ).toBeTrue();
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-approval-command-too-long',
        method: 'runtime/command',
        params: {
          command: {
            ...command,
            interaction: { ...command.interaction, command: 'x'.repeat(16_385) },
          },
        },
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-4',
        method: 'runtime/command',
        params: {
          command: {
            schema: 'kite.runtime-command.v1',
            commandId: 'command-multiline',
            type: 'start_turn',
            sessionId: 'session-1',
            expectedRevision: 7,
            input: 'first line\nsecond line',
          },
        },
      }).success,
    ).toBeTrue();
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        ...initializeRequest,
        id: 'rpc\ninvalid',
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-3',
        method: 'runtime/command',
        params: { command: { ...command, response: { kind: 'text', value: 'no' } } },
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-4',
        method: 'runtime/command',
        params: {
          command: {
            schema: 'kite.runtime-command.v1',
            commandId: 'command-3',
            type: 'start_turn',
            sessionId: 'session-1',
            expectedRevision: 7,
            input: 'continue',
            initialSkills: [{ skillId: 'skill-1', input: { enabled: true, retry: 2 } }],
          },
        },
      }).success,
    ).toBeTrue();
  });

  test('validates every response branch and binds numeric errors to stable codes', () => {
    expect(
      RUNTIME_PROTOCOL_RESPONSE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-5',
        result: { status: 'ok' },
      }).success,
    ).toBeTrue();
    expect(
      RUNTIME_PROTOCOL_RESPONSE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-5',
        result: { arbitrary: 'result' },
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_RESPONSE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-5',
        error: { code: -32005, message: 'Unauthorized', data: { code: 'unauthorized' } },
      }).success,
    ).toBeTrue();
    expect(
      RUNTIME_PROTOCOL_RESPONSE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'rpc-5',
        error: { code: -32004, message: 'Unauthorized', data: { code: 'unauthorized' } },
      }).success,
    ).toBeFalse();
  });

  test('encodes bounded private Run get/page and original resource receipts', () => {
    const run = {
      schema: 'kite.runtime-run.v1' as const,
      sessionId: 'session-1',
      runId: 'run-1',
      phase: 'building' as const,
      status: 'queued' as const,
      createdRevision: 4,
      lastRevision: 4,
      createdAtMs: 1_700_000_000_000,
    };
    const listQuery = {
      schema: 'kite.runtime-query.v1' as const,
      type: 'list_runs' as const,
      sessionId: 'session-1',
      cursor: { createdRevision: 3, runId: 'run-0' },
      limit: 200,
    };
    expect(mapRuntimeQueryToProtocol(listQuery)).toEqual(listQuery);
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        id: 'run-query',
        method: 'runtime/query',
        params: { query: { ...listQuery, limit: 201 } },
      }).success,
    ).toBeFalse();
    expect(
      mapRuntimeQueryResultToProtocol({
        status: 'ok',
        queryType: 'list_runs',
        runs: [run],
        nextRunCursor: { createdRevision: 4, runId: 'run-1' },
      }),
    ).toEqual({
      status: 'ok',
      queryType: 'list_runs',
      runs: [run],
      nextRunCursor: { createdRevision: 4, runId: 'run-1' },
    });
    const receipt = {
      status: 'idempotent_replay' as const,
      commandId: 'command-1',
      sessionId: 'session-1',
      originalRevision: 4,
      resource: { kind: 'run' as const, run },
    };
    expect(RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse(receipt).success).toBeTrue();
    expect(
      RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
        ...receipt,
        resource: { ...receipt.resource, privateCommand: 'hidden' },
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
        ...receipt,
        resource: {
          kind: 'run',
          run: { ...run, status: 'running', startedAtMs: 1_700_000_000_001 },
        },
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
        status: 'ok',
        queryType: 'get_run',
        run: { ...run, status: 'failed', finishedAtMs: 1_700_000_000_002 },
      }).success,
    ).toBeFalse();
  });

  test('only maps explicit browser-safe event variants', () => {
    expect(
      mapRuntimeClientEventToProtocol({
        type: 'user.message',
        messageId: 'message-1',
        kind: 'task',
        text: 'visible',
      }),
    ).toEqual({ type: 'user.message', messageId: 'message-1', kind: 'task', text: 'visible' });
    expect(mapRuntimeClientEventToProtocol({ type: 'unavailable', reason: 'redacted' })).toEqual({
      type: 'unavailable',
      reason: 'redacted',
    });
    expect(
      mapRuntimeClientEventToProtocol({
        type: 'model.text_delta',
        requestId: 'request-1',
        text: 'visible',
      }),
    ).toEqual({ type: 'model.text_delta', requestId: 'request-1', text: 'visible' });
    expect(
      mapRuntimeClientEventToProtocol({ type: 'model.text_delta', text: 'visible' } as never),
    ).toBeUndefined();
    expect(
      mapRuntimeClientEventToProtocol({
        type: 'tool.queued',
        toolId: 'tool-1',
        presentationGroupId: 'model-message-1',
        toolName: 'read_file',
        presentation: 'exploration',
        arguments: { path: '/workspace/src/index.ts', pattern: 'needle' },
        summary: 'Queued.',
      }),
    ).toEqual({
      type: 'tool.queued',
      toolId: 'tool-1',
      presentationGroupId: 'model-message-1',
      toolName: 'read_file',
      presentation: 'exploration',
      arguments: { path: '/workspace/src/index.ts', pattern: 'needle' },
      summary: 'Queued.',
    });
    expect(
      mapRuntimeClientEventToProtocol({
        type: 'tool.finished',
        toolId: 'tool-1',
        toolName: 'read_file',
        presentation: 'exploration',
        result: {
          ok: true,
          exitCode: 0,
          stdout: '/workspace/src/index.ts',
          stderr: '',
          totalLines: 1,
        },
        summary: 'Completed.',
      }),
    ).toEqual({
      type: 'tool.finished',
      toolId: 'tool-1',
      toolName: 'read_file',
      presentation: 'exploration',
      result: {
        ok: true,
        exitCode: 0,
        stdout: '/workspace/src/index.ts',
        stderr: '',
        totalLines: 1,
      },
      summary: 'Completed.',
    });
    const approvalQueued = {
      type: 'approval.queued' as const,
      interaction: {
        kind: 'approval' as const,
        interactionId: 'approval-1',
        sessionRevision: 8,
        generation: 0,
        grants: ['approve_once'] as ('approve_once' | 'same_command')[],
        command: 'git status --short --branch',
        title: 'shell_execute',
        summary: 'Approve a shell command',
      },
      queueSequence: 0,
    };
    expect(mapRuntimeClientEventToProtocol(approvalQueued)).toEqual(approvalQueued);
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'tool.queued',
        toolId: 'tool-1',
        toolName: 'mcp__private__credential=secret',
        presentation: 'exploration',
        arguments: {},
        summary: 'Queued.',
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'tool.queued',
        toolId: 'tool-1',
        presentation: 'unknown',
        arguments: {},
        summary: 'Queued.',
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'tool.finished',
        toolId: 'tool-1',
        presentation: 'standalone',
        result: { ok: true, exitCode: 0, stdout: '', stderr: '', resultMeta: {} },
        summary: 'Completed.',
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'tool.queued',
        toolId: 'tool-unsafe',
        presentation: 'standalone',
        arguments: { amount: Number.MAX_SAFE_INTEGER + 1 },
        summary: 'Queued.',
      }).success,
    ).toBeFalse();
    const prototypeArguments = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototypeArguments, '__proto__', { enumerable: true, value: 'blocked' });
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'tool.queued',
        toolId: 'tool-prototype',
        presentation: 'standalone',
        arguments: prototypeArguments,
        summary: 'Queued.',
      }).success,
    ).toBeFalse();
    let deeplyNested: unknown = 'leaf';
    for (let index = 0; index <= RUNTIME_PROTOCOL_LIMITS.maxDepth; index++) {
      deeplyNested = { nested: deeplyNested };
    }
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'tool.queued',
        toolId: 'tool-deep',
        presentation: 'standalone',
        arguments: deeplyNested,
        summary: 'Queued.',
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'tool.finished',
        toolId: 'tool-large-output',
        presentation: 'standalone',
        result: {
          ok: true,
          exitCode: 0,
          stdout: 'x'.repeat(RUNTIME_PROTOCOL_LIMITS.maxTextLength + 1),
          stderr: '',
        },
        summary: 'Completed.',
      }).success,
    ).toBeFalse();
    expect(
      mapRuntimeClientEventToProtocol({
        type: 'reasoning.activity',
        requestId: 'request-1',
        state: 'streaming',
        segmentId: 'reasoning-1',
        text: 'Inspecting local state.',
      }),
    ).toEqual({
      type: 'reasoning.activity',
      requestId: 'request-1',
      state: 'streaming',
      segmentId: 'reasoning-1',
      text: 'Inspecting local state.',
    });
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'reasoning.activity',
        state: 'streaming',
        segmentId: 'reasoning-1',
        text: 'Inspecting local state.',
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'model.responded',
        requestId: 'request-1',
        messageId: 'message-1',
        toolCallCount: -1,
      }).success,
    ).toBeFalse();
    expect(
      RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse({
        type: 'model.responded',
        requestId: 'request-long-answer',
        messageId: 'message-long-answer',
        toolCallCount: 0,
        summary: 'x'.repeat(10_000),
      }).success,
    ).toBeTrue();
    expect(mapRuntimeClientEventToProtocol({ type: 'planning.exited', taskId: 'task-1' })).toEqual({
      type: 'planning.exited',
      taskId: 'task-1',
    });
    expect(
      mapRuntimeClientEventToProtocol({
        type: 'run.failure',
        runId: 'run-1',
        code: 'provider_unavailable',
        retryable: true,
        recoveryEntry: 'retry',
      }),
    ).toEqual({
      type: 'run.failure',
      runId: 'run-1',
      code: 'provider_unavailable',
      retryable: true,
      recoveryEntry: 'retry',
    });
    expect(
      mapRuntimeClientEventToProtocol({
        type: 'rewind.terminal',
        rewindId: 'rewind-1',
        commandId: 'rewind-command-1',
        sourceSessionId: 'session-1',
        targetSessionId: 'session-2',
        status: 'completed',
        fileOutcome: { restored: ['safe.txt'], deleted: [], failed: [], conflicts: [] },
      }),
    ).toEqual({
      type: 'rewind.terminal',
      rewindId: 'rewind-1',
      commandId: 'rewind-command-1',
      sourceSessionId: 'session-1',
      targetSessionId: 'session-2',
      status: 'completed',
      fileOutcome: { restored: ['safe.txt'], deleted: [], failed: [], conflicts: [] },
    });
    expect(mapRuntimeClientEventToProtocol({ type: 'future_event' } as never)).toBeUndefined();
    expect(
      mapRuntimeNotificationToSubscriptionMessage({
        schema: 'kite.runtime-notification.v1',
        durability: 'durable',
        sessionId: 'session-1',
        revision: 4,
        projection: {
          kind: 'snapshot',
          session: {
            schema: 'kite.runtime-projection.v1',
            sessionId: 'session-1',
            revision: 4,
            workspace: '/private/workspace',
            lifecycle: 'open',
            sessionCommandGrantCount: 2,
            interactionQueue: { revision: 4, interactions: [] },
          },
        },
      }),
    ).toEqual({
      type: 'notification',
      durability: 'durable',
      sessionId: 'session-1',
      revision: 4,
      session: {
        schema: 'kite.runtime-projection.v1',
        sessionId: 'session-1',
        revision: 4,
        lifecycle: 'open',
        sessionCommandGrantCount: 2,
        interactionQueue: { revision: 4, interactions: [] },
      },
    });
  });

  test('preserves closed session-index reset boundaries for the client store', () => {
    const wire = mapRuntimeAccessNotificationToSubscriptionMessage({
      type: 'session_upsert',
      serverInstanceId: 'server-1',
      generation: 2,
      indexRevision: 4,
      session: {
        schema: 'kite.runtime-projection.v1',
        sessionId: 'session-1',
        revision: 4,
        workspace: '/private/workspace',
        lifecycle: 'open',
        sessionCommandGrantCount: 2,
        interactionQueue: { revision: 4, interactions: [] },
      },
    });
    expect(wire).toEqual({
      type: 'session_upsert',
      serverInstanceId: 'server-1',
      generation: 2,
      indexRevision: 4,
      session: {
        schema: 'kite.runtime-projection.v1',
        sessionId: 'session-1',
        revision: 4,
        lifecycle: 'open',
        sessionCommandGrantCount: 2,
        interactionQueue: { revision: 4, interactions: [] },
      },
    });
    expect(mapSubscriptionMessageToClientUpdate(wire)).toEqual(wire);
  });

  test('preserves ephemeral stream identity and rejects unknown fields', () => {
    const message = mapRuntimeNotificationToSubscriptionMessage({
      schema: 'kite.runtime-notification.v1',
      durability: 'ephemeral',
      sessionId: 'session-1',
      workId: 'work-1',
      turnId: 'turn-1',
      actorId: 'actor-1',
      attemptId: 'attempt-1',
      compositionRevision: 'composition-1',
      streamId: 'stream-1',
      sequence: 3,
      event: {
        type: 'tool.progress',
        toolId: 'tool-1',
        summary: 'running',
        stream: 'stdout',
        lineCount: 2,
      },
    });
    expect(message).toEqual({
      type: 'notification',
      durability: 'ephemeral',
      sessionId: 'session-1',
      workId: 'work-1',
      turnId: 'turn-1',
      actorId: 'actor-1',
      attemptId: 'attempt-1',
      compositionRevision: 'composition-1',
      streamId: 'stream-1',
      sequence: 3,
      event: {
        type: 'tool.progress',
        toolId: 'tool-1',
        summary: 'running',
        stream: 'stdout',
        lineCount: 2,
      },
    });
    expect(
      RUNTIME_SUBSCRIPTION_MESSAGE_SCHEMA_.safeParse({ ...message, unexpected: true }).success,
    ).toBeFalse();
  });

  test('preserves terminal taxonomy and active work while removing workspace', () => {
    expect(
      RUNTIME_PROTOCOL_MESSAGE_SCHEMA_.safeParse({
        jsonrpc: '2.0',
        method: 'runtime/subscription',
        params: {
          subscriptionId: 'subscription-1',
          generation: 1,
          message: {
            type: 'notification',
            durability: 'durable',
            sessionId: 'session-1',
            revision: 3,
            event: {
              type: 'run.terminal',
              runId: 'run-1',
              status: 'failed',
              outcome: {
                status: 'resource_saturated',
                reasonCode: 'queue_full',
                safeRetry: true,
                recoveryEntry: 'retry',
              },
            },
            session: {
              schema: 'kite.runtime-projection.v1',
              sessionId: 'session-1',
              revision: 3,
              lifecycle: 'open',
              sessionCommandGrantCount: 0,
              interactionQueue: {
                revision: 3,
                activeInteractionId: 'interaction-1',
                interactions: [
                  {
                    kind: 'input',
                    interactionId: 'interaction-1',
                    sessionRevision: 3,
                    question: 'Continue?',
                    allowFreeText: true,
                  },
                ],
              },
              activeWork: {
                workId: 'work-1',
                phase: 'building',
                status: 'running',
                activeTurn: {
                  turnId: 'turn-1',
                  status: 'waiting',
                  interaction: {
                    kind: 'input',
                    interactionId: 'interaction-1',
                    sessionRevision: 3,
                    question: 'Continue?',
                    allowFreeText: true,
                  },
                  evidence: [{ kind: 'test', status: 'pending' }],
                },
              },
            },
          },
        },
      }).success,
    ).toBeTrue();
  });

  test('rejects same-revision active approval fields with different command identity', () => {
    const approval = {
      kind: 'approval' as const,
      interactionId: 'approval-full-identity',
      sessionRevision: 3,
      generation: 1,
      command: 'bun test',
      grants: ['approve_once' as const],
    };
    const session = {
      schema: 'kite.runtime-projection.v1' as const,
      sessionId: 'session-1',
      revision: 3,
      lifecycle: 'open' as const,
      sessionCommandGrantCount: 0,
      interactionQueue: {
        revision: 3,
        activeInteractionId: approval.interactionId,
        interactions: [approval],
      },
      activeWork: {
        workId: 'work-1',
        phase: 'building' as const,
        status: 'waiting' as const,
        activeTurn: {
          turnId: 'turn-1',
          status: 'waiting' as const,
          interaction: { ...approval, grants: ['same_command' as const] },
        },
      },
    };

    expect(RUNTIME_PROTOCOL_SESSION_SCHEMA_.safeParse(session).success).toBeFalse();
  });

  test('keeps generated artifacts at the checked-in canonical digest', () => {
    const generated = generateRuntimeProtocolArtifacts();
    const expectedDigest = '4d6cf5fe:7013c1fc';
    expect(generated.schema).toBe('kite.runtime-protocol.v1');
    expect(generateRuntimeProtocolArtifactDigest()).toBe(expectedDigest);
    expect(generated.typeScript).toBe(generateRuntimeProtocolTypeScript());
    expect(generated.typeScript).not.toContain('RuntimeCommandParams');
    expect(generated.typeScript).toContain("method: 'initialize'");
    expect(generated.typeScript).toContain("method: 'runtime/command'");
    expect(generated.typeScript).toContain("method: 'history/list_sessions'");
    expect(generated.typeScript).toContain("method: 'app/workspace_trust/query'");
    expect(generated.typeScript).toContain("method: 'app/provider_credential/write'");
    expect(generated.typeScript).toContain("method: 'server/ping'");
    expect(generated.typeScript).toContain('RuntimeProtocolToolPresentation');
    expect(generated.typeScript).toContain('RuntimeProtocolToolQueuedEvent');
    expect(generated.typeScript).toContain('RuntimeProtocolToolFinishedEvent');
    expect(generated.typeScript).toContain('RuntimeProtocolReasoningActivity');
    expect(generated.typeScript).toContain('RuntimeProtocolModelTextDeltaEvent');
    expect(generated.typeScript).toContain('RuntimeProtocolModelRespondedEvent');
    expectStandaloneRequestArtifactCompiles(generated.typeScript);
  });
});

function expectStandaloneRequestArtifactCompiles(declaration: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'kite-runtime-protocol-artifact-'));
  const source = join(directory, 'runtime-protocol-artifact.ts');
  try {
    writeFileSync(
      source,
      `${declaration}

const initialize: RuntimeProtocolRequest = {
  jsonrpc: '2.0',
  id: 'initialize-1',
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientInfo: { name: 'test', version: '1', instanceId: 'client-1' },
  },
};

const command: RuntimeProtocolRequest = {
  jsonrpc: '2.0',
  id: 'command-1',
  method: 'runtime/command',
  params: {
    command: {
      schema: 'kite.runtime-command.v1',
      commandId: 'command-1',
      type: 'create_session',
    },
  },
};

// @ts-expect-error initialize accepts only initialize params.
const mismatchedMethodAndParams: RuntimeProtocolRequest = {
  jsonrpc: '2.0',
  id: 'mismatch-1',
  method: 'initialize',
  params: command.params,
};

const pingWithExtraParams: RuntimeProtocolRequest = {
  jsonrpc: '2.0',
  id: 'ping-extra-1',
  method: 'server/ping',
  // @ts-expect-error ping params are an exact empty object.
  params: { unexpected: true },
};

void initialize;
void command;
void mismatchedMethodAndParams;
void pingWithExtraParams;
`,
    );
    const program = ts.createProgram([source], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
