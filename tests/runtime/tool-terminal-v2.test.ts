import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import { AgentKernel, createAgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import {
  buildRuntimeEventEnvelopeV24,
  canonicalRuntimeEventEnvelopeBytesV24,
} from '@/core/runtime/runtime-event-v24';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import {
  assertToolTerminalControlBatchV2,
  finalizeToolTerminalEventV2,
  validateVerifiedToolTerminalEventV2,
} from '@/core/runtime/tool-terminal-v2';
import {
  CORE_TOOL_FAILURE_BUDGET_V2,
  coreToolFailureContentV2,
  finalizeProjectedToolResultV2,
  resolveBuiltinToolResultBudgetV2,
  STREAM_TOOL_RESULT_BUDGET_V2,
} from '@/core/tools/result-budget-v2';

function queuedState(args: unknown = { command: 'echo ok' }) {
  return reduceRuntimeState(
    createInitialRuntimeState({
      threadId: 'terminal-v2',
      userId: 'u',
      workspace: '/',
    }),
    {
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'shell_execute',
      args,
      modelMessageId: 'assistant-1',
    },
  );
}

describe('schema-v22 self-contained tool terminals', () => {
  test('finished/failed/rejected/cancelled each carry one verified model result', () => {
    const state = queuedState();
    const terminals = [
      {
        type: 'tool.finished' as const,
        toolCallId: 'call-1',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'echo ok',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        },
      },
      { type: 'tool.failed' as const, toolCallId: 'call-1', error: 'failed' },
      {
        type: 'tool.rejected' as const,
        toolCallId: 'call-1',
        reason: 'rejected',
      },
      {
        type: 'tool.cancelled' as const,
        toolCallId: 'call-1',
        reason: 'cancelled',
      },
    ];
    for (const event of terminals) {
      const finalized = finalizeToolTerminalEventV2(state, event, 'compat_v1');
      expect(finalized.modelResult.kind).toBe('verified_v2');
      expect(finalized.modelResult.resultMeta.toolResultReceipt.projectionMode).toBe('compat_v1');
      expect(finalized.modelResult.terminalIdentity).toMatch(/^[0-9a-f]{64}$/);
      expect(() =>
        validateVerifiedToolTerminalEventV2(state, finalized, 'compat_v1'),
      ).not.toThrow();
    }
  });

  test('budget_v2 terminal failure is bounded and never includes raw args or error text', () => {
    const secret = 'SECRET-raw-argument-and-provider-error';
    const state = queuedState({ command: secret });
    for (const event of [
      { type: 'tool.failed' as const, toolCallId: 'call-1', error: secret },
      { type: 'tool.rejected' as const, toolCallId: 'call-1', reason: secret },
      { type: 'tool.cancelled' as const, toolCallId: 'call-1', reason: secret },
    ]) {
      const finalized = finalizeToolTerminalEventV2(state, event, 'budget_v2');
      expect(finalized.modelResult.ok).toBe(false);
      expect(finalized.modelResult.modelContent).toContain('core-tool-failure:v1');
      expect(finalized.modelResult.modelContent).not.toContain(secret);
      expect(Buffer.byteLength(finalized.modelResult.modelContent, 'utf8')).toBeLessThanOrEqual(
        2_048,
      );
      expect(finalized.modelResult.resultMeta.toolResultReceipt.projectionMode).toBe('budget_v2');
    }
  });

  test('budget_v2 finalizes successful ask_user and runtime-bound MCP results without core failure', () => {
    let askState = reduceRuntimeState(
      createInitialRuntimeState({
        threadId: 'ask-success',
        userId: 'u',
        workspace: '/',
      }),
      {
        type: 'tool.queued',
        toolCallId: 'ask-1',
        name: 'ask_user',
        args: { question: 'Continue?' },
        modelMessageId: 'assistant-1',
      },
    );
    const ask = finalizeToolTerminalEventV2(
      askState,
      {
        type: 'tool.finished',
        toolCallId: 'ask-1',
        name: 'ask_user',
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: JSON.stringify({ answer: 'yes' }),
          stderr: '',
        },
      },
      'budget_v2',
    );
    expect(ask.modelResult.modelContent).toBe('{"answer":"yes"}');
    expect(ask.modelResult.modelContent).not.toContain('core-tool-failure:v1');

    askState = reduceRuntimeState(askState, ask);
    const dynamicState = reduceRuntimeState(askState, {
      type: 'tool.queued',
      toolCallId: 'mcp-1',
      name: 'mcp__github__read',
      args: {},
      modelMessageId: 'assistant-2',
      bindingId: 'binding-1',
      capabilityId: 'mcp:github/read',
      capabilityRevision: 'cap-r1',
    });
    dynamicState.capabilities.catalogRevision = 'catalog-r1';
    const content = '🙂'.repeat(40_000);
    const mcp = finalizeToolTerminalEventV2(
      dynamicState,
      {
        type: 'tool.finished',
        toolCallId: 'mcp-1',
        name: 'mcp__github__read',
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: content,
          stderr: '',
        },
      },
      'budget_v2',
    );
    expect(mcp.modelResult.modelContent).not.toContain('core-tool-failure:v1');
    expect(Buffer.byteLength(mcp.modelResult.modelContent, 'utf8')).toBeLessThanOrEqual(
      128 * 1_024,
    );
    expect(mcp.modelResult.resultMeta.toolResultReceipt.toolIdentity).toBe('mcp:github/read');
  });

  test('rejects tampered binding, raw digest, byte count, content, and terminal identity', () => {
    const state = queuedState();
    const valid = finalizeToolTerminalEventV2(
      state,
      { type: 'tool.failed', toolCallId: 'call-1', error: 'failed' },
      'compat_v1',
    );
    for (const mutate of [
      (copy: typeof valid) => {
        copy.modelResult.resultMeta.toolResultReceipt.bindingDigest = '0'.repeat(64);
      },
      (copy: typeof valid) => {
        copy.modelResult.resultMeta.toolResultReceipt.rawResultDigest = '1'.repeat(64);
      },
      (copy: typeof valid) => {
        copy.modelResult.resultMeta.toolResultReceipt.modelContentUtf8Bytes += 1;
      },
      (copy: typeof valid) => {
        copy.modelResult.modelContent += 'tampered';
      },
      (copy: typeof valid) => {
        copy.modelResult.terminalIdentity = '2'.repeat(64);
      },
    ]) {
      const copy = structuredClone(valid);
      mutate(copy);
      expect(() => validateVerifiedToolTerminalEventV2(state, copy, 'compat_v1')).toThrow();
    }
  });

  test('stream terminal receipt binds both projected streams and their finite limits', () => {
    const state = queuedState();
    const projected = finalizeProjectedToolResultV2({
      rawResult: { stdout: 'ok', stderr: 'warning' },
      projected: {
        ok: true,
        modelContent: 'ok',
        streams: { stdout: 'ok', stderr: 'warning' },
        resultMeta: {},
      },
      resolvedBudget: resolveBuiltinToolResultBudgetV2({
        toolName: 'shell_execute',
        budget: STREAM_TOOL_RESULT_BUDGET_V2,
        governanceRevision: 'shell-effects-v1',
      }),
      projectionMode: 'budget_v2',
    });
    const event = finalizeToolTerminalEventV2(
      state,
      {
        type: 'tool.finished',
        toolCallId: 'call-1',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'echo ok',
          exitCode: 0,
          stdout: projected.streams!.stdout,
          stderr: projected.streams!.stderr,
          resultMeta: projected.resultMeta,
        },
      },
      'budget_v2',
    );
    expect(event.modelResult.streams).toEqual({
      stdout: 'ok',
      stderr: 'warning',
    });
    expect(event.modelResult.resultMeta.toolResultReceipt.streamProjection).toBeDefined();
    const tamperedStream = structuredClone(event);
    tamperedStream.modelResult.streams!.stderr = 'tampered';
    expect(() => validateVerifiedToolTerminalEventV2(state, tamperedStream)).toThrow();
    const tamperedLimit = structuredClone(event);
    tamperedLimit.modelResult.resultMeta.toolResultReceipt.streamProjection!.stdoutChars = 20_000;
    expect(() => validateVerifiedToolTerminalEventV2(state, tamperedLimit)).toThrow();

    const producerless = finalizeToolTerminalEventV2(
      state,
      {
        type: 'tool.finished',
        toolCallId: 'call-1',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'echo ok',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        },
      },
      'budget_v2',
    );
    expect(producerless.modelResult.modelContent).toContain('core-tool-failure:v1');
  });

  test('Kernel persists the verified terminal and conflicting replay fails closed', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({
        threadId: 'kernel-terminal',
        userId: 'u',
        workspace: '/',
      }),
      interactionMode: 'accept_edits',
      toolResultProjectionMode: 'compat_v1',
    });
    kernel.processEvent({
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'shell_execute',
      args: { command: 'echo ok' },
      modelMessageId: 'assistant-1',
    });
    kernel.processEvent({
      type: 'tool.failed',
      toolCallId: 'call-1',
      error: 'first',
    });
    const terminal = store.loadEventsStrict('kernel-terminal').at(-1)?.event;
    expect(terminal?.type).toBe('tool.failed');
    if (terminal?.type === 'tool.failed') {
      expect(terminal.modelResult?.kind).toBe('verified_v2');
    }
    expect(() =>
      kernel.processEvent({
        type: 'tool.failed',
        toolCallId: 'call-1',
        error: 'conflict',
      }),
    ).toThrow('Conflicting terminal replay');
    kernel.close();
  });

  test('durable post-execution projection failure retains no-retry effect certainty', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({
        threadId: 'projection-failure-terminal',
        userId: 'u',
        workspace: '/',
      }),
      interactionMode: 'accept_edits',
      toolResultProjectionMode: 'budget_v2',
    });
    kernel.processEvent({
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'projection_failure_fixture',
      args: {},
      modelMessageId: 'assistant-1',
    });
    const failure = {
      ...classifyFailure(
        'projection_failed_after_execution',
        'Tool execution completed, but projection failed.',
      ),
      executionCertainty: 'executed' as const,
      knownExternalEffects: 'unknown' as const,
    };
    const projected = finalizeProjectedToolResultV2({
      rawResult: {
        code: 'projection_failed_after_execution',
        executionCertainty: failure.executionCertainty,
        knownExternalEffects: failure.knownExternalEffects,
      },
      projected: {
        ok: false,
        modelContent: coreToolFailureContentV2('projection_failed_after_execution'),
        resultMeta: { projectionFailure: failure },
      },
      resolvedBudget: resolveBuiltinToolResultBudgetV2({
        toolName: 'core-tool-failure:v1',
        budget: CORE_TOOL_FAILURE_BUDGET_V2,
      }),
      projectionMode: 'budget_v2',
    });
    kernel.processEvent({
      type: 'tool.finished',
      toolCallId: 'call-1',
      name: 'projection_failure_fixture',
      result: {
        ok: false,
        command: 'projection_failure_fixture',
        exitCode: -1,
        stdout: '',
        stderr: projected.modelContent,
        resultMeta: projected.resultMeta,
      },
    });
    const persisted = store.loadEventsStrict('projection-failure-terminal').at(-1)?.event;
    expect(persisted?.type).toBe('tool.finished');
    if (persisted?.type === 'tool.finished' && persisted.modelResult?.kind === 'verified_v2') {
      expect(persisted.modelResult.resultMeta.projectionFailure).toMatchObject({
        kind: 'projection_failed_after_execution',
        retryable: false,
        executionCertainty: 'executed',
        knownExternalEffects: 'unknown',
      });
    }
    expect(
      kernel.getState().tools.calls['call-1']?.result?.resultMeta?.projectionFailure,
    ).toMatchObject({
      retryable: false,
      executionCertainty: 'executed',
      knownExternalEffects: 'unknown',
    });
    kernel.close();
  });

  test('restore validates durable receipt mode independently of the current flag', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-terminal-restore-'));
    const storePath = join(directory, 'runtime.db');
    try {
      const writerStore = createRuntimeStore(storePath);
      const writer = new AgentKernel({
        store: writerStore,
        initialState: createInitialRuntimeState({
          threadId: 'restore-budget-terminal',
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
        toolResultProjectionMode: 'budget_v2',
      });
      writer.processEvent({
        type: 'tool.queued',
        toolCallId: 'call-1',
        name: 'shell_execute',
        args: { command: 'echo ok' },
        modelMessageId: 'assistant-1',
      });
      const terminal = finalizeToolTerminalEventV2(
        writer.getState(),
        {
          type: 'tool.failed',
          toolCallId: 'call-1',
          error: 'secret provider failure',
        },
        'budget_v2',
      );
      writer.close();

      const tailStore = createRuntimeStore(storePath);
      const terminalEnvelope = buildRuntimeEventEnvelopeV24({
        threadId: 'restore-budget-terminal',
        generation: tailStore.loadPersistenceIdentity('restore-budget-terminal').generation,
        revision: 2,
        occurredAt: new Date(0).toISOString(),
        payload: terminal,
      });
      tailStore.appendEvents(
        'restore-budget-terminal',
        [terminalEnvelope.payload],
        [
          {
            eventId: terminalEnvelope.eventId,
            revision: terminalEnvelope.revision,
            occurredAt: terminalEnvelope.occurredAt,
            schemaVersion: 24,
            generation: terminalEnvelope.generation,
            canonicalBytes: Buffer.byteLength(
              canonicalRuntimeEventEnvelopeBytesV24(terminalEnvelope),
              'utf8',
            ),
          },
        ],
      );
      tailStore.close();

      const restored = createAgentKernel({
        storePath,
        threadId: 'restore-budget-terminal',
        userId: 'u',
        workspace: '/',
        toolResultProjectionMode: 'compat_v1',
      });
      expect(restored.getState().recoveryState.kind).toBe('normal');
      expect(restored.getState().tools.calls['call-1']?.status).toBe('failed');
      expect(
        restored.getState().tools.calls['call-1']?.result?.resultMeta?.toolResultReceipt
          ?.projectionMode,
      ).toBe('budget_v2');
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('restore quarantines a tampered verified terminal in the event tail', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-terminal-tamper-'));
    const storePath = join(directory, 'runtime.db');
    try {
      const writerStore = createRuntimeStore(storePath);
      const writer = new AgentKernel({
        store: writerStore,
        initialState: createInitialRuntimeState({
          threadId: 'restore-tampered-terminal',
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
        toolResultProjectionMode: 'budget_v2',
      });
      writer.processEvent({
        type: 'tool.queued',
        toolCallId: 'call-1',
        name: 'shell_execute',
        args: { command: 'echo ok' },
        modelMessageId: 'assistant-1',
      });
      const terminal = structuredClone(
        finalizeToolTerminalEventV2(
          writer.getState(),
          {
            type: 'tool.failed',
            toolCallId: 'call-1',
            error: 'provider failure',
          },
          'budget_v2',
        ),
      );
      terminal.modelResult.modelContent += 'tampered';
      writer.close();

      const tailStore = createRuntimeStore(storePath);
      const terminalEnvelope = buildRuntimeEventEnvelopeV24({
        threadId: 'restore-tampered-terminal',
        generation: tailStore.loadPersistenceIdentity('restore-tampered-terminal').generation,
        revision: 2,
        occurredAt: new Date(0).toISOString(),
        payload: terminal,
      });
      tailStore.appendEvents(
        'restore-tampered-terminal',
        [terminalEnvelope.payload],
        [
          {
            eventId: terminalEnvelope.eventId,
            revision: terminalEnvelope.revision,
            occurredAt: terminalEnvelope.occurredAt,
            schemaVersion: 24,
            generation: terminalEnvelope.generation,
            canonicalBytes: Buffer.byteLength(
              canonicalRuntimeEventEnvelopeBytesV24(terminalEnvelope),
              'utf8',
            ),
          },
        ],
      );
      tailStore.close();

      const restored = createAgentKernel({
        storePath,
        threadId: 'restore-tampered-terminal',
        userId: 'u',
        workspace: '/',
        toolResultProjectionMode: 'compat_v1',
      });
      expect(restored.getState().recoveryState.kind).toBe('corrupted');
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('restore validates legal schema-v22 snapshots and quarantines missing or changed proof', () => {
    for (const mutation of ['none', 'missing_receipt', 'terminal_identity'] as const) {
      const directory = mkdtempSync(join(tmpdir(), `openpx-terminal-snapshot-${mutation}-`));
      const storePath = join(directory, 'runtime.db');
      const threadId = `snapshot-${mutation}`;
      try {
        const writerStore = createRuntimeStore(storePath);
        const writer = new AgentKernel({
          store: writerStore,
          initialState: createInitialRuntimeState({
            threadId,
            userId: 'u',
            workspace: '/',
          }),
          interactionMode: 'accept_edits',
          toolResultProjectionMode: 'budget_v2',
        });
        writer.processEvent({
          type: 'tool.queued',
          toolCallId: 'call-1',
          name: 'shell_execute',
          args: { command: 'echo ok' },
          modelMessageId: 'assistant-1',
        });
        writer.processEvent({
          type: 'tool.failed',
          toolCallId: 'call-1',
          error: 'bounded failure',
        });
        writer.close();

        if (mutation !== 'none') {
          const tamperStore = createRuntimeStore(storePath);
          const tampered = structuredClone(tamperStore.loadSnapshot<RuntimeState>(threadId));
          if (!tampered) throw new Error('Expected a persisted terminal snapshot.');
          const callMeta = tampered.tools.calls['call-1']?.result?.resultMeta;
          const message = tampered.transcript.messages.find(
            (candidate) => candidate.kind === 'tool' && candidate.toolCallId === 'call-1',
          );
          if (!callMeta || message?.kind !== 'tool' || !message.resultMeta) {
            throw new Error('Expected a complete durable terminal.');
          }
          const messageMeta = message.resultMeta;
          if (mutation === 'missing_receipt') {
            delete callMeta.toolResultReceipt;
            delete messageMeta.toolResultReceipt;
          } else {
            callMeta.terminalIdentity = 'f'.repeat(64);
            messageMeta.terminalIdentity = 'f'.repeat(64);
          }
          // saveSnapshot recomputes a valid Store checksum, so recovery must
          // reject semantic proof tampering rather than relying on checksum failure.
          tamperStore.appendEventsAndSnapshot(
            threadId,
            [],
            tampered,
            [],
            undefined,
            tamperStore.loadPersistenceIdentity(threadId),
          );
          tamperStore.close();
        }

        const restored = createAgentKernel({
          threadId,
          userId: 'u',
          workspace: '/',
          storePath,
        });
        expect(restored.getState().recoveryState.kind).toBe(
          mutation === 'none' ? 'normal' : 'corrupted',
        );
        restored.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test('restore binds every terminal variant to call status and all result ok fields', () => {
    const terminalCases: Array<{
      label: string;
      event: RuntimeEvent;
      status: 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'exhausted';
      ok: boolean;
    }> = [
      {
        label: 'finished-success',
        event: {
          type: 'tool.finished',
          toolCallId: 'call-1',
          name: 'shell_execute',
          result: {
            ok: true,
            command: 'echo ok',
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
          },
        },
        status: 'succeeded',
        ok: true,
      },
      {
        label: 'finished-failed',
        event: {
          type: 'tool.finished',
          toolCallId: 'call-1',
          name: 'shell_execute',
          result: {
            ok: false,
            command: 'false',
            exitCode: 1,
            stdout: '',
            stderr: 'failed',
            status: 'error',
          },
        },
        status: 'failed',
        ok: false,
      },
      {
        label: 'finished-exhausted',
        event: {
          type: 'tool.finished',
          toolCallId: 'call-1',
          name: 'shell_execute',
          result: {
            ok: false,
            command: 'long-running',
            exitCode: 124,
            stdout: '',
            stderr: 'budget exhausted',
            status: 'exhausted',
          },
        },
        status: 'exhausted',
        ok: false,
      },
      {
        label: 'failed',
        event: {
          type: 'tool.failed',
          toolCallId: 'call-1',
          error: 'failed',
        },
        status: 'failed',
        ok: false,
      },
      {
        label: 'rejected',
        event: {
          type: 'tool.rejected',
          toolCallId: 'call-1',
          reason: 'rejected',
        },
        status: 'rejected',
        ok: false,
      },
      {
        label: 'cancelled',
        event: {
          type: 'tool.cancelled',
          toolCallId: 'call-1',
          reason: 'cancelled',
        },
        status: 'cancelled',
        ok: false,
      },
    ];
    const mutations = ['none', 'call_status', 'call_result_ok', 'message_ok'] as const;

    for (const terminalCase of terminalCases) {
      for (const mutation of mutations) {
        const directory = mkdtempSync(
          join(tmpdir(), `openpx-terminal-state-${terminalCase.label}-${mutation}-`),
        );
        const storePath = join(directory, 'runtime.db');
        const threadId = `${terminalCase.label}-${mutation}`;
        try {
          const writerStore = createRuntimeStore(storePath);
          const writer = new AgentKernel({
            store: writerStore,
            initialState: createInitialRuntimeState({
              threadId,
              userId: 'u',
              workspace: '/',
            }),
            interactionMode: 'accept_edits',
            toolResultProjectionMode: 'compat_v1',
          });
          writer.processEvent({
            type: 'tool.queued',
            toolCallId: 'call-1',
            name: 'shell_execute',
            args: { command: 'echo ok' },
            modelMessageId: 'assistant-1',
          });
          writer.processEvent(structuredClone(terminalCase.event));
          writer.close();

          if (mutation !== 'none') {
            const tamperStore = createRuntimeStore(storePath);
            const tampered = structuredClone(tamperStore.loadSnapshot<RuntimeState>(threadId)!);
            const call = tampered.tools.calls['call-1']!;
            const message = tampered.transcript.messages.find(
              (candidate) => candidate.kind === 'tool' && candidate.toolCallId === 'call-1',
            );
            if (!call.result || message?.kind !== 'tool') {
              throw new Error('Expected canonical settled tool state.');
            }
            if (mutation === 'call_status') {
              call.status = terminalCase.status === 'succeeded' ? 'failed' : 'succeeded';
            } else if (mutation === 'call_result_ok') {
              call.result.ok = !terminalCase.ok;
            } else {
              message.ok = !terminalCase.ok;
            }
            // Recompute the Store checksum to prove semantic validation, not
            // envelope integrity, rejects each independently forged field.
            tamperStore.appendEventsAndSnapshot(
              threadId,
              [],
              tampered,
              [],
              undefined,
              tamperStore.loadPersistenceIdentity(threadId),
            );
            tamperStore.close();
          }

          const restored = createAgentKernel({
            threadId,
            userId: 'u',
            workspace: '/',
            storePath,
          });
          expect(restored.getState().recoveryState.kind).toBe(
            mutation === 'none' ? 'normal' : 'corrupted',
          );
          if (mutation === 'none') {
            const call = restored.getState().tools.calls['call-1']!;
            const message = restored
              .getState()
              .transcript.messages.find(
                (candidate) => candidate.kind === 'tool' && candidate.toolCallId === 'call-1',
              );
            expect(call.status).toBe(terminalCase.status);
            expect(call.result?.ok).toBe(terminalCase.ok);
            expect(message?.kind === 'tool' ? message.ok : undefined).toBe(terminalCase.ok);
          }
          restored.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  });
});

describe('control + terminal batch closure', () => {
  test('Kernel single-event and processEvents APIs cannot bypass companion validation', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({
        threadId: 'control-api',
        userId: 'u',
        workspace: '/',
      }),
      interactionMode: 'accept_edits',
    });
    kernel.processEvents([
      {
        type: 'tool.queued',
        toolCallId: 'call-1',
        name: 'shell_execute',
        args: {},
        modelMessageId: 'assistant-1',
      },
      {
        type: 'approval.requested',
        interactionId: 'approval-1',
        toolCallId: 'call-1',
        approval: {
          scope: 'once',
          cwd: '/',
          threadId: 'control-api',
          tool: 'shell_execute',
          command: 'true',
          risk: 'execute_code',
          approvalHash: 'approval-1-hash',
          summary: 'Run the fixture command.',
          reason: 'Exercise the control closure.',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      },
    ]);
    const control = {
      type: 'approval.rejected' as const,
      interactionId: 'approval-1',
      toolCallId: 'call-1',
      reason: 'no',
    };
    expect(() => kernel.processEvent(control)).toThrow('immediate matching tool.rejected');
    expect(() => kernel.processEvents([control])).toThrow('immediate matching tool.rejected');
    expect(kernel.getState().interactions.kind).toBe('awaiting_tool_approval');
    kernel.close();
  });

  test('requires target terminal immediately after every terminal-owning control', () => {
    expect(() =>
      assertToolTerminalControlBatchV2([
        {
          type: 'approval.rejected',
          interactionId: 'approval-1',
          toolCallId: 'call-1',
          reason: 'no',
        },
      ]),
    ).toThrow('immediate matching tool.rejected');
    expect(() =>
      assertToolTerminalControlBatchV2([
        {
          type: 'auto_review.completed',
          reviewId: 'review-1',
          toolCallId: 'call-1',
          result: {
            ok: true,
            approved: false,
            reviewerModelName: 'reviewer',
            durationMs: 1,
          },
        },
      ]),
    ).toThrow('immediate matching tool.rejected');
    expect(() =>
      assertToolTerminalControlBatchV2([
        {
          type: 'provider.action_required',
          interactionId: 'provider-1',
          providerId: 'github',
          action: 'login',
          originatingToolCallId: 'call-1',
        },
      ]),
    ).toThrow('immediate matching tool.failed');
    expect(() =>
      assertToolTerminalControlBatchV2([
        {
          type: 'user_input.cancelled',
          interactionId: 'input-1',
          toolCallId: 'call-1',
          reason: 'no answer',
        },
      ]),
    ).toThrow('immediate matching tool.finished');
    expect(() =>
      assertToolTerminalControlBatchV2([
        {
          type: 'plan.review_cancelled',
          interactionId: 'plan-review-1',
          toolCallId: 'call-1',
          planId: 'plan-1',
          version: 1,
          structuralDigest: 'digest',
          reason: 'cancel',
        },
      ]),
    ).toThrow('immediate matching tool.cancelled');
  });

  test('accepts ask-user non-abort and provider control with exactly one owned terminal', () => {
    expect(() =>
      assertToolTerminalControlBatchV2([
        {
          type: 'user_input.cancelled',
          interactionId: 'input-1',
          toolCallId: 'call-1',
          reason: 'no answer',
        },
        {
          type: 'tool.finished',
          toolCallId: 'call-1',
          name: 'ask_user',
          result: {
            ok: false,
            command: '',
            exitCode: -1,
            stdout: 'Cancelled',
            stderr: '',
          },
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertToolTerminalControlBatchV2([
        {
          type: 'provider.action_required',
          interactionId: 'provider-1',
          providerId: 'github',
          action: 'login',
          originatingToolCallId: 'call-1',
        },
        { type: 'tool.failed', toolCallId: 'call-1', error: 'login required' },
      ]),
    ).not.toThrow();
  });

  test('allows provider recovery as pure control only when a canonical result already exists', () => {
    const terminal = finalizeToolTerminalEventV2(
      queuedState(),
      { type: 'tool.failed', toolCallId: 'call-1', error: 'login required' },
      'compat_v1',
    );
    const failedState = reduceRuntimeState(queuedState(), terminal);
    const control = {
      type: 'provider.action_required' as const,
      interactionId: 'provider-1',
      providerId: 'github',
      action: 'login' as const,
      originatingToolCallId: 'call-1',
    };
    expect(() => assertToolTerminalControlBatchV2([control], failedState)).not.toThrow();
    expect(() => assertToolTerminalControlBatchV2([control], queuedState())).toThrow(
      'immediate matching tool.failed',
    );
  });

  test('rejects duplicate terminals and terminals after turn.aborted', () => {
    expect(() =>
      assertToolTerminalControlBatchV2([
        { type: 'tool.cancelled', toolCallId: 'call-1', reason: 'x' },
        { type: 'tool.failed', toolCallId: 'call-1', error: 'x' },
      ]),
    ).toThrow('Duplicate tool terminal');
    expect(() =>
      assertToolTerminalControlBatchV2([
        { type: 'turn.aborted', turnId: 'turn-1', reason: 'x', cause: 'user' },
        { type: 'tool.cancelled', toolCallId: 'call-1', reason: 'x' },
      ]),
    ).toThrow('must precede turn.aborted');
    expect(() =>
      assertToolTerminalControlBatchV2([
        { type: 'resource_budget.released', reservationId: 'reservation-1' },
        { type: 'tool.cancelled', toolCallId: 'call-1', reason: 'x' },
      ]),
    ).toThrow('must precede resource facts');
    expect(() =>
      assertToolTerminalControlBatchV2([
        { type: 'tool.cancelled', toolCallId: 'call-1', reason: 'x' },
        {
          type: 'approval.rejected',
          interactionId: 'approval-2',
          toolCallId: 'call-2',
          reason: 'x',
        },
        { type: 'tool.rejected', toolCallId: 'call-2', reason: 'x' },
      ]),
    ).toThrow('control must precede target and sibling terminals');
  });
});
