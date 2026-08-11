import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@/core/runtime/events';
import { AgentKernel } from '@/core/runtime/kernel';
import {
  buildRuntimeEventEnvelopeV24,
  canonicalRuntimeEventIdV24,
} from '@/core/runtime/runtime-event-v24';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

describe('runtime event registry v24', () => {
  test('derives identity from the final durable envelope and Store mechanically revalidates it', () => {
    const store = createRuntimeStore(':memory:');
    const state = createInitialRuntimeState({ threadId: 'v24', userId: 'u', workspace: '/' });
    const kernel = new AgentKernel({ store, initialState: state, interactionMode: 'accept_edits' });
    const applied = kernel.processEvent({
      type: 'user.command_invoked',
      commandId: 'context',
      command: '/context',
    });
    const row = store.loadEventsStrict('v24')[0]!;
    expect(row.event_id).toBe(applied.eventId);
    expect(row.producer_generation).toBe(1);
    expect(row.canonical_bytes).toBeGreaterThan(0);
    expect(
      canonicalRuntimeEventIdV24({
        schemaVersion: 24,
        generation: 1,
        threadId: 'v24',
        eventId: row.event_id!,
        revision: row.revision!,
        causationId: row.causation_id ?? null,
        occurredAt: row.occurred_at!,
        payload: row.event,
      }),
    ).toBe(applied.eventId);
    expect(() =>
      store.appendEvents('v24', [
        { type: 'user.command_invoked', commandId: 'legacy', command: '/legacy' },
      ]),
    ).toThrow('Schema-v24 cutover rejects metadata-less append');
    kernel.close();
  });

  test('tracks the last transcript-producing cut without advancing it for control events', () => {
    const store = createRuntimeStore(':memory:');
    const state = createInitialRuntimeState({
      threadId: 'source-cut',
      userId: 'u',
      workspace: '/',
    });
    const kernel = new AgentKernel({ store, initialState: state, interactionMode: 'accept_edits' });
    const transcriptEvent = kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'source-message',
      content: 'durable source',
    });
    const sourceCut = kernel.getState().context.lastTranscriptProducingEventCutV1;
    expect(sourceCut).toEqual({ revision: 1, eventId: transcriptEvent.eventId });
    kernel.processEvent({
      type: 'user.command_invoked',
      commandId: 'context-command',
      command: '/context',
    });
    expect(kernel.getState().context.lastTranscriptProducingEventCutV1).toEqual(sourceCut);
    kernel.close();
  });

  test('rejects forged canonical ids and stale producer generations', () => {
    const store = createRuntimeStore(':memory:');
    const state = createInitialRuntimeState({ threadId: 'forged', userId: 'u', workspace: '/' });
    const kernel = new AgentKernel({ store, initialState: state, interactionMode: 'accept_edits' });
    const envelope = buildRuntimeEventEnvelopeV24({
      threadId: 'forged',
      generation: 1,
      revision: 1,
      occurredAt: new Date(0).toISOString(),
      payload: { type: 'user.command_invoked', commandId: 'x', command: '/x' },
    });
    expect(() => kernel.processEvent({ ...envelope, eventId: '0'.repeat(64) })).toThrow(
      'canonical event identity mismatch',
    );
    expect(() => kernel.processEvent({ ...envelope, generation: 2 })).toThrow(
      'canonical event identity mismatch',
    );
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'forged',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        causationId: '界'.repeat(43),
        payload: { type: 'user.command_invoked', commandId: 'x', command: '/x' },
      }),
    ).toThrow('causationId must be 1..128 UTF-8 bytes');
    kernel.close();
  });

  test('keeps the closed ephemeral registry out of revision and durable storage', () => {
    const store = createRuntimeStore(':memory:');
    const state = createInitialRuntimeState({ threadId: 'ephemeral', userId: 'u', workspace: '/' });
    const kernel = new AgentKernel({ store, initialState: state, interactionMode: 'accept_edits' });
    kernel.processEvent({ type: 'model.text_delta', text: 'partial' });
    kernel.processEvent({ type: 'model.reasoning_completed', segmentId: 's', text: 'reasoning' });
    expect(kernel.getState().revision).toBe(0);
    expect(store.getLastEventPosition('ephemeral')).toBe(0);
    kernel.close();
  });

  test('rejects event types outside the exhaustive v24 registry', () => {
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'unknown-type',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload: { type: 'totally.unknown' } as unknown as RuntimeEvent,
      }),
    ).toThrow("Unknown Runtime event type 'totally.unknown'");
  });

  test('rejects unknown and missing fields under the per-discriminant v24 schema', () => {
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'exact-fields',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload: {
          type: 'user.command_invoked',
          commandId: 'command',
          command: '/status',
          injected: true,
        } as unknown as RuntimeEvent,
      }),
    ).toThrow("unknown v24 field 'injected'");
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'exact-fields',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload: {
          type: 'user.command_invoked',
          commandId: 'command',
        } as unknown as RuntimeEvent,
      }),
    ).toThrow("missing required v24 field 'command'");
  });

  test('rejects unbounded nested values before canonicalization', () => {
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'nested-budget',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload: {
          type: 'tool.queued',
          toolCallId: 'tool',
          name: 'shell',
          args: { content: 'x'.repeat(128 * 1024 + 1) },
        },
      }),
    ).toThrow('string exceeds the byte limit');

    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let depth = 0; depth < 26; depth++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'nested-budget',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload: {
          type: 'tool.queued',
          toolCallId: 'tool',
          name: 'shell',
          args: tooDeep,
        },
      }),
    ).toThrow('depth limit');
  });

  test('rejects unknown nested fields in progressive Summary identities', () => {
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'nested-summary-schema',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload: {
          type: 'context.summary_requested_v1',
          attempt: {
            attemptId: 'attempt',
            compactionId: 'compaction',
            reason: 'manual',
            trigger: 'manual_plain',
            summarySourceIdentity: {
              version: 1,
              firstMessageId: 'first',
              coveredThroughMessageId: 'last',
              coveredThroughTurnId: 'turn',
              canonicalSourceDigest: 'a'.repeat(64),
              sourceProjectionPolicyId: 'canonical-transcript-blocks:v1',
              injected: true,
            },
            requestedAtRevision: 1,
            requestedAtTurnId: 'turn',
            sourceProducingEventCutV1: { revision: 1, eventId: 'b'.repeat(64) },
            estimate: {
              systemTokens: 0,
              toolSchemaTokens: 0,
              transcriptTokens: 1,
              summaryTokens: 0,
              dynamicRuntimeTokens: 0,
              framingTokens: 0,
              totalInputTokens: 1,
            },
          },
        } as unknown as RuntimeEvent,
      }),
    ).toThrow('Summary source identity contains missing or unknown v24 fields');
  });

  test('rejects unknown nested fields in legacy compaction estimates', () => {
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'nested-estimate',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload: {
          type: 'context.compaction_requested',
          compactionId: 'compaction',
          reason: 'manual',
          requestedAtRevision: 0,
          requestedAtTurnId: 'turn',
          force: false,
          estimate: {
            systemTokens: 1,
            toolSchemaTokens: 1,
            transcriptTokens: 1,
            summaryTokens: 1,
            dynamicRuntimeTokens: 1,
            framingTokens: 1,
            totalInputTokens: 7,
            totallyUnknownNestedField: true,
          },
        } as unknown as RuntimeEvent,
      }),
    ).toThrow('Context token estimate contains missing or unknown v24 fields');
  });

  test('rejects unknown fields across durable nested domain objects', () => {
    const build = (payload: RuntimeEvent) =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'nested-domain-schema',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload,
      });
    const cases: RuntimeEvent[] = [
      {
        type: 'authorization.changed',
        mode: 'default',
        commandGrants: {
          exact: {
            workspace: '/',
            threadId: 'thread',
            command: 'true',
            source: 'user',
            grantedAt: new Date(0).toISOString(),
            injected: true,
          } as never,
        },
      },
      {
        type: 'capability.bindings_issued',
        catalogRevision: 'catalog',
        bindings: [
          {
            bindingId: 'binding',
            capabilityId: 'capability',
            capabilityRevision: 'revision',
            exposedToolName: 'tool',
            schemaDigest: 'digest',
            issuedForTurnId: 'turn',
            injected: true,
          } as never,
        ],
      },
      {
        type: 'resource_budget.reconciled',
        reservationId: 'reservation',
        actual: {
          counters: {
            turns: 0,
            modelRequests: 0,
            toolInvocations: 0,
            inputTokens: 0,
            outputTokens: 0,
            artifactBytes: 0,
            injected: 1,
          },
          gauges: {
            elapsedRunMs: 0,
            activeSubagents: 0,
            activeWriters: 0,
            activeToolInvocations: 0,
            activeShellInvocations: 0,
          },
          source: 'actual',
        } as never,
      },
      {
        type: 'verification.requested',
        verificationId: 'verification',
        mode: 'required',
        requestedAt: new Date(0).toISOString(),
        spec: {
          schemaVersion: 1,
          verificationId: 'verification',
          subject: 'subject',
          checks: [
            {
              type: 'command',
              checkId: 'check',
              description: 'check it',
              command: 'true',
              injected: true,
            },
          ],
          repair: { maxAttempts: 1 },
        } as never,
      },
      {
        type: 'model.responded',
        messageId: 'message',
        toolCalls: [{ id: 'call', name: 'tool', args: {}, injected: true } as never],
      },
      {
        type: 'tool.finished',
        toolCallId: 'call',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'true',
          exitCode: 0,
          stdout: '',
          stderr: '',
          injected: true,
        } as never,
      },
    ];
    for (const event of cases) expect(() => build(event)).toThrow('unknown v24 fields');
  });

  test('keeps explicitly open JSON maps bounded but not falsely exact', () => {
    expect(() =>
      buildRuntimeEventEnvelopeV24({
        threadId: 'open-json-map',
        generation: 1,
        revision: 1,
        occurredAt: new Date(0).toISOString(),
        payload: {
          type: 'verification.requested',
          verificationId: 'verification',
          mode: 'required',
          requestedAt: new Date(0).toISOString(),
          spec: {
            schemaVersion: 1,
            verificationId: 'verification',
            subject: 'subject',
            checks: [
              {
                type: 'schema',
                checkId: 'schema',
                description: 'validate an open JSON payload',
                subject: { kind: 'literal', value: { arbitraryDomainKey: true } },
                schema: { arbitrarySchemaKeyword: { nested: true } },
              },
            ],
            repair: { maxAttempts: 1 },
          },
        },
      }),
    ).not.toThrow();
  });
});
