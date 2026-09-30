import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import type { RuntimeLogQueryPort } from '@kite-ai/runtime-host/storage';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import { createKiteRuntimeStorageOwner } from '../src/bootstrap';
import type { RuntimeEvent } from '../src/bootstrap/runtime/state-runtime';
import { childRuntimeToolCallId } from '../src/runtime/tool-execution/subagent-tool-identity';
import {
  createKiteRuntimeHistoryClient,
  createKiteRuntimeObserverHistoryClient,
} from '../src/runtime-client/history-adapter';

function historyLogs(events: readonly RuntimeEvent[]): RuntimeLogQueryPort<RuntimeEvent> {
  return {
    listSessions: () => ({
      entries: [
        {
          sessionId: 'ownership-history',
          name: 'History',
          updatedAt: 42,
          lastSequence: events.length,
        },
      ],
      hasMore: false,
    }),
    listEvents: (request) => ({
      entries: events
        .map((event, index) => ({
          sessionId: 'ownership-history',
          sequence: index + 1,
          eventId: `event-${index + 1}`,
          createdAt: 42 + index,
          event,
        }))
        .filter(
          (entry) =>
            entry.sequence > (request.afterSequence ?? 0) &&
            entry.sequence < (request.beforeSequence ?? Number.POSITIVE_INFINITY),
        )
        .slice(0, request.limit),
      hasMore: false,
      observedLastSequence: events.length,
    }),
    close: () => undefined,
  };
}

function invocationRecorded(invocationId: string, toolCallId: string): RuntimeEvent {
  return {
    type: 'capability.invocation_recorded',
    invocationId,
    toolCallId,
    capabilityId: 'builtin:task',
    capabilityRevision: '1',
    argumentsDigest: 'args',
    authorizationDigest: 'auth',
    effectiveEffectsDigest: 'effects',
    effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
    recordedAt: '2026-09-17T00:00:00.000Z',
  };
}

function dispatchIntent(invocationId: string, childInvocationId: string): RuntimeEvent {
  return {
    type: 'capability.subagent_dispatch_intent_recorded',
    invocationId,
    childInvocationId,
    attempt: 1,
    purpose: 'start',
    taskArtifact: {
      artifactId: `pa_${'7'.repeat(64)}`,
      kind: 'subagent_task',
      integrityIdentifier: `sha256:${'8'.repeat(64)}`,
      byteLength: 128,
    },
    dispatchIntentDigest: `sha256:${'9'.repeat(64)}`,
    recordedAt: '2026-09-17T00:00:00.000Z',
  };
}

describe('Kite Runtime History Client adapter', () => {
  test('legacy per-transcript limits no longer reject a valid observer history', async () => {
    const history = createKiteRuntimeObserverHistoryClient(
      () =>
        historyLogs([
          { type: 'user.message_appended', messageId: 'one', content: 'first message' },
          { type: 'user.message_appended', messageId: 'two', content: 'second message' },
        ]),
      undefined,
      { maxSourceBytes: 1, maxProjectedBytes: 1, maxRecords: 1 },
    );
    const transcript = await history.loadSession('ownership-history');
    expect(transcript.records).toHaveLength(2);
    expect(transcript.events).toHaveLength(2);
  });

  test('Store rewrite and instance proofs reuse live prefixes without rescanning or hashing', async () => {
    const events = new Map([[1, 'first']]);
    let generation = 1;
    let rewriteGeneration = 0;
    let instanceId = 'a'.repeat(32);
    let reads = 0;
    let hashes = 0;
    const history = createKiteRuntimeObserverHistoryClient(
      () => ({
        getSession: () => ({
          sessionId: 'live-proof',
          name: 'Live proof',
          updatedAt: 1,
          lastSequence: Math.max(...events.keys()),
          historyGeneration: generation,
          historyRewriteGeneration: rewriteGeneration,
          historyInstanceId: instanceId,
        }),
        listSessions: () => ({ entries: [], hasMore: false }),
        listEvents: (request) => {
          reads++;
          return {
            entries: [...events]
              .filter(
                ([sequence]) =>
                  sequence > (request.afterSequence ?? 0) &&
                  sequence < (request.beforeSequence ?? Infinity),
              )
              .map(([sequence, content]) => ({
                sessionId: 'live-proof',
                sequence,
                eventId: `event-${sequence}`,
                createdAt: sequence,
                event: {
                  type: 'user.message_appended' as const,
                  messageId: `message-${sequence}`,
                  content,
                },
              })),
            hasMore: false,
            observedLastSequence: Math.max(...events.keys()),
          };
        },
        close: () => undefined,
      }),
      undefined,
      {
        fingerprintEventRows: () => {
          hashes++;
          throw new Error('proof should avoid hashing');
        },
      },
    );
    const first = await history.loadSession('live-proof');
    for (let sequence = 2; sequence <= 24; sequence++) {
      events.set(sequence, 'tail');
      generation++;
      expect((await history.loadSession('live-proof', 1)).snapshotDigest).toBe(
        first.snapshotDigest,
      );
    }
    expect(reads).toBe(1);
    expect(hashes).toBe(0);
    events.set(1, 'rewritten');
    generation++;
    rewriteGeneration++;
    expect((await history.loadSession('live-proof', 1)).snapshotDigest).not.toBe(
      first.snapshotDigest,
    );
    expect(reads).toBe(2);
    events.set(1, 'new instance');
    instanceId = 'b'.repeat(32);
    expect((await history.loadSession('live-proof', 1)).events[0]).toMatchObject({
      text: 'new instance',
    });
    expect(reads).toBe(3);
    expect(hashes).toBe(0);
  });

  test('reuses an append-only fixed prefix and rescans rewrites or inserts inside it', async () => {
    const events = new Map<number, string>([[1, 'original']]);
    let generation = 1;
    let reads = 0;
    let failProof = false;
    const history = createKiteRuntimeObserverHistoryClient(
      () => ({
        getSession: () => ({
          sessionId: 'appending',
          name: 'Appending',
          updatedAt: 1,
          lastSequence: Math.max(...events.keys()),
          historyGeneration: generation,
        }),
        listSessions: () => ({ entries: [], hasMore: false }),
        listEvents: (request) => {
          reads++;
          return {
            entries: [...events]
              .filter(
                ([sequence]) =>
                  sequence > (request.afterSequence ?? 0) &&
                  sequence < (request.beforeSequence ?? Number.POSITIVE_INFINITY),
              )
              .sort(([a], [b]) => a - b)
              .map(([sequence, content]) => ({
                sessionId: 'appending',
                sequence,
                eventId: `event-${sequence}`,
                createdAt: sequence,
                event: {
                  type: 'user.message_appended' as const,
                  messageId: `message-${sequence}`,
                  content,
                },
              })),
            hasMore: false,
            observedLastSequence: Math.max(...events.keys()),
          };
        },
        close: () => undefined,
      }),
      undefined,
      {
        maxSourceBytes: 100_000,
        maxProjectedBytes: 100_000,
        maxRecords: 100,
        fingerprintEventRows: (_sessionId, throughSequence) => {
          if (failProof) throw new Error('fingerprint unavailable');
          return JSON.stringify([...events].filter(([sequence]) => sequence <= throughSequence));
        },
      },
    );
    const first = await history.loadSession('appending');
    events.set(3, 'tail');
    generation++;
    const reused = await history.loadSession('appending', 1);
    expect(reused.snapshotDigest).toBe(first.snapshotDigest);
    expect(reads).toBe(1);

    events.set(1, 'rewritten');
    generation++;
    const changed = await history.loadSession('appending', 1);
    expect(changed.snapshotDigest).not.toBe(first.snapshotDigest);
    expect(reads).toBe(2);

    const pinned = await history.loadSession('appending', 3);
    events.set(2, 'inserted in prefix');
    generation++;
    await history.loadSession('appending', 3);
    expect(reads).toBe(4);
    expect((await history.loadSession('appending', 3)).snapshotDigest).not.toBe(
      pinned.snapshotDigest,
    );
    const readCount = reads;
    events.set(1, 'replacement after generation reset');
    generation = 2;
    const replaced = await history.loadSession('appending', 3);
    expect(reads).toBe(readCount + 1);
    expect(replaced.events[0]).toMatchObject({
      type: 'user.message',
      text: 'replacement after generation reset',
    });
    events.set(4, 'new tail');
    generation++;
    failProof = true;
    const readsBeforeProofFailure = reads;
    const afterProofFailure = await history.loadSession('appending', 3);
    expect(afterProofFailure.snapshotDigest).toBe(replaced.snapshotDigest);
    expect(reads).toBe(readsBeforeProofFailure + 1);
  });

  test('reuses fresh root and child projections, including pinned first loads after a same-sequence rewrite', async () => {
    const content = new Map([
      ['root', 'root one'],
      ['child', 'child one'],
    ]);
    const generations = new Map([
      ['root', 1],
      ['child', 1],
    ]);
    const reads = new Map<string, number>();
    const reader = (visibleSession: string): RuntimeLogQueryPort<RuntimeEvent> => ({
      getSession: (sessionId) =>
        sessionId === visibleSession
          ? {
              sessionId,
              name: sessionId,
              updatedAt: 1,
              lastSequence: 1,
              historyGeneration: generations.get(sessionId)!,
            }
          : null,
      listSessions: () => ({ entries: [], hasMore: false }),
      listEvents: (request) => {
        reads.set(visibleSession, (reads.get(visibleSession) ?? 0) + 1);
        return {
          entries: [
            {
              sessionId: visibleSession,
              sequence: 1,
              eventId: `${visibleSession}-event`,
              createdAt: 1,
              event: {
                type: 'user.message_appended' as const,
                messageId: `${visibleSession}-message`,
                content: content.get(visibleSession)!,
              },
            },
          ].filter(
            (entry) => entry.sequence < (request.beforeSequence ?? Number.POSITIVE_INFINITY),
          ),
          hasMore: false,
          observedLastSequence: 1,
        };
      },
      close: () => undefined,
    });
    const history = createKiteRuntimeObserverHistoryClient(
      () => reader('root'),
      (parent, child) => reader(parent === 'root' ? child : 'denied'),
    );
    const firstRoot = await history.loadSession('root');
    const firstChild = await history.loadChildSession!('root', 'child');
    await history.loadSession('root');
    await history.loadChildSession!('root', 'child');
    await history.loadChildSession!('root', 'child', 1);
    expect(reads).toEqual(
      new Map([
        ['root', 1],
        ['child', 1],
      ]),
    );

    content.set('child', 'child revised');
    generations.set('child', 2);
    const revisedChild = await history.loadChildSession!('root', 'child', 1);
    expect(revisedChild.snapshotDigest).not.toBe(firstChild.snapshotDigest);
    expect(revisedChild.events[0]).toMatchObject({ type: 'user.message', text: 'child revised' });
    await history.loadSession('root');
    expect(firstRoot.events[0]).toMatchObject({ type: 'user.message', text: 'root one' });
    expect(reads).toEqual(
      new Map([
        ['root', 1],
        ['child', 2],
      ]),
    );
  });

  test('bounds an unpinned read by the Session sequence observed before journal scanning', async () => {
    const observedBeforeSequences: number[] = [];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      getSession: () => ({
        sessionId: 'appending',
        name: 'Appending',
        updatedAt: 1,
        lastSequence: 2,
      }),
      listSessions: () => ({ entries: [], hasMore: false }),
      listEvents: (request) => {
        observedBeforeSequences.push(request.beforeSequence ?? -1);
        return {
          entries: [1, 2, 3]
            .filter((sequence) => sequence < (request.beforeSequence ?? Number.POSITIVE_INFINITY))
            .map((sequence) => ({
              sessionId: 'appending',
              sequence,
              eventId: `event-${sequence}`,
              createdAt: 1,
              event: {
                type: 'user.message_appended' as const,
                messageId: `message-${sequence}`,
                content: `message ${sequence}`,
              },
            })),
          hasMore: false,
          observedLastSequence: 3,
        };
      },
      close: () => undefined,
    };
    const history = createKiteRuntimeObserverHistoryClient(logs);
    const transcript = await history.loadSession('appending');
    expect(observedBeforeSequences).toEqual([3]);
    expect(transcript.session.lastSequence).toBe(2);
    expect(transcript.records.map((record) => record.sequence)).toEqual([1, 2]);
    await history.loadSession('appending', 2);
    expect(observedBeforeSequences).toEqual([3, 3]);
  });

  test('reuses fixed root and child transcripts across pages but checks child lineage on every read', async () => {
    const events = Array.from(
      { length: 401 },
      (_, index): RuntimeEvent => ({
        type: 'user.message_appended',
        messageId: `message-${index}`,
        content: `message ${index}`,
      }),
    );
    let parent = 'parent';
    let historyGeneration = 1;
    let rootReads = 0;
    let childReads = 0;
    const reader = (sessionId: string, child: boolean): RuntimeLogQueryPort<RuntimeEvent> => ({
      getSession: (requested) =>
        requested === sessionId && (!child || parent === 'parent')
          ? {
              sessionId,
              name: sessionId,
              updatedAt: 1,
              lastSequence: events.length,
              historyGeneration,
            }
          : null,
      listSessions: () => ({ entries: [], hasMore: false }),
      listEvents: (request) => {
        if (child) childReads++;
        else rootReads++;
        const entries = events
          .map((event, index) => ({
            sessionId,
            sequence: index + 1,
            eventId: `${sessionId}-${index + 1}`,
            createdAt: 1,
            event,
          }))
          .filter(
            (entry) =>
              entry.sequence > (request.afterSequence ?? 0) &&
              entry.sequence < (request.beforeSequence ?? Number.POSITIVE_INFINITY),
          );
        return {
          entries: entries.slice(0, request.limit),
          hasMore: entries.length > request.limit,
          ...(entries.length > request.limit
            ? { nextCursor: entries[request.limit - 1]!.sequence }
            : {}),
          observedLastSequence: events.length,
        };
      },
      close: () => undefined,
    });
    const history = createKiteRuntimeObserverHistoryClient(
      () => reader('root', false),
      (requestedParent, childId) => reader(requestedParent === parent ? childId : 'denied', true),
    );
    const root = await history.loadSession('root');
    expect(root.records).toHaveLength(401);
    expect(rootReads).toBe(3);
    expect((await history.loadSession('root', root.session.lastSequence)).records).toHaveLength(
      401,
    );
    expect(rootReads).toBe(3);
    events[0] = { type: 'user.message_appended', messageId: 'replacement', content: 'revised' };
    historyGeneration++;
    const revised = await history.loadSession('root');
    expect(revised.snapshotDigest).not.toBe(root.snapshotDigest);
    expect(revised.events[0]).toMatchObject({ type: 'user.message', text: 'revised' });
    expect(
      (await history.loadSession('root', revised.session.lastSequence)).events[0],
    ).toMatchObject({
      type: 'user.message',
      text: 'revised',
    });
    expect(rootReads).toBe(6);

    const child = await history.loadChildSession!('parent', 'child');
    expect(child.records).toHaveLength(401);
    expect(childReads).toBe(3);
    expect(
      (await history.loadChildSession!('parent', 'child', child.session.lastSequence)).records,
    ).toHaveLength(401);
    expect(childReads).toBe(3);
    await expect(history.loadChildSession!('other-parent', 'child', 401)).rejects.toMatchObject({
      code: 'session_not_found',
    });
    parent = 'moved-parent';
    await expect(history.loadChildSession!('parent', 'child', 401)).rejects.toMatchObject({
      code: 'session_not_found',
    });

    // A same-watermark rewrite that outgrows the bounded cache must discard
    // the prior version before the next continuation is read.
    const largeContent = 'x'.repeat(48_000);
    for (let index = 0; index < events.length; index++) {
      events[index] = {
        type: 'user.message_appended',
        messageId: `replacement-${index}`,
        content: largeContent,
      };
    }
    historyGeneration++;
    await history.loadSession('root');
    const readsAfterOversizedFirstPage = rootReads;
    const largeContinuation = await history.loadSession('root', 401);
    expect(largeContinuation.events[0]).toMatchObject({
      type: 'user.message',
      messageId: 'replacement-0',
      text: largeContent,
    });
    expect(rootReads).toBe(readsAfterOversizedFirstPage + 3);
  });

  test('loads an immediate child only through the explicitly scoped History reader', async () => {
    const childEvent: RuntimeEvent = {
      type: 'user.message_appended',
      messageId: 'child-message',
      content: 'child task',
    };
    const scopes: string[] = [];
    const history = createKiteRuntimeHistoryClient(
      () => ({
        listSessions: () => ({ entries: [], hasMore: false }),
        getSession: () => null,
        listEvents: () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        close: () => undefined,
      }),
      undefined,
      (parentSessionId, childSessionId) => {
        scopes.push(`${parentSessionId}/${childSessionId}`);
        const allowed = parentSessionId === 'parent' && childSessionId === 'child';
        return {
          getSession: (sessionId) =>
            allowed && sessionId === 'child'
              ? { sessionId, name: 'Child', updatedAt: 1, lastSequence: 1 }
              : null,
          listEvents: (request) => ({
            entries:
              allowed && request.sessionId === 'child' && !request.afterSequence
                ? [
                    {
                      sessionId: 'child',
                      sequence: 1,
                      eventId: 'child-event',
                      createdAt: 1,
                      event: childEvent,
                    },
                  ]
                : [],
            hasMore: false,
            observedLastSequence: allowed ? 1 : 0,
          }),
          close: () => undefined,
        };
      },
    );
    await expect(history.loadSession('child')).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(history.loadChildSession?.('parent', 'child')).resolves.toMatchObject({
      session: { sessionId: 'child' },
      records: [{ sequence: 1 }],
    });
    await expect(history.loadChildSession?.('sibling', 'child')).rejects.toMatchObject({
      code: 'session_not_found',
    });
    expect(scopes).toEqual(['parent/child', 'parent/child', 'sibling/child']);
  });
  test('repairs legacy child ownership from exact lifecycle and step facts within the selected history', async () => {
    const parentToolCallId = 'parent-task-tool';
    const subagentId = 'child-invocation';
    const step = {
      id: subagentId,
      stepId: 'step-1',
      toolCallId: 'model-child-tool',
      modelInvocationId: 'model-child-invocation',
      toolName: 'read_file',
      toolArgs: { path: 'README.md' },
    };
    const childToolId = childRuntimeToolCallId({
      parentToolCallId,
      subagentId,
      modelInvocationId: step.modelInvocationId,
      modelToolCallId: step.toolCallId,
      toolName: step.toolName,
      args: step.toolArgs,
    });
    const events: RuntimeEvent[] = [
      invocationRecorded('parent-invocation', parentToolCallId),
      dispatchIntent('parent-invocation', subagentId),
      { type: 'subagent.started', subagent: { id: subagentId, role: 'explore', name: 'Inspect' } },
      { type: 'subagent.step', subagent: step },
      {
        type: 'tool.queued',
        toolCallId: childToolId,
        modelMessageId: 'child-model-message',
        name: 'read_file',
        args: step.toolArgs,
        presentation: 'standalone',
      },
      {
        type: 'tool.failed',
        toolCallId: childToolId,
        presentation: 'standalone',
        failure: { kind: 'unknown', message: 'failed' },
      } as RuntimeEvent,
    ];
    const history = createKiteRuntimeHistoryClient(historyLogs(events));
    const loaded = await history.loadSession!('ownership-history');
    expect(loaded.events.find((event) => event.type === 'subagent.started')).toMatchObject({
      parentToolCallId,
    });
    expect(
      loaded.events.filter((event) => event.type === 'tool.queued' || event.type === 'tool.failed'),
    ).toMatchObject([
      {
        toolId: childToolId,
        presentation: 'hidden',
        presentationOwner: { subagentId, parentToolCallId },
      },
      {
        toolId: childToolId,
        presentation: 'hidden',
        presentationOwner: { subagentId, parentToolCallId },
      },
    ]);
    expect((await history.loadSession!('ownership-history', 3)).events).toMatchObject([
      { type: 'subagent.started', parentToolCallId },
    ]);
    expect(loaded.events.find((event) => event.type === 'subagent.step')).toMatchObject({
      toolCallId: childToolId,
    });
    expect(
      (await history.loadSession!('ownership-history', 4)).events.find(
        (event) => event.type === 'subagent.step',
      ),
    ).toMatchObject({ toolCallId: step.toolCallId });
    expect((await history.loadSession!('ownership-history')).records).toEqual(loaded.records);
    expect(events[2]).toEqual({
      type: 'subagent.started',
      subagent: { id: subagentId, role: 'explore', name: 'Inspect' },
    });
  });

  test('reveals only hidden parent Tasks with unique child dispatch proof', async () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool.queued',
        toolCallId: 'completed-parent',
        modelMessageId: 'parent-model',
        name: 'task',
        args: {},
        presentation: 'hidden',
      },
      {
        type: 'tool.queued',
        toolCallId: 'failed-parent',
        modelMessageId: 'parent-model',
        name: 'task',
        args: {},
        presentation: 'hidden',
      },
      {
        type: 'tool.queued',
        toolCallId: 'unproven-parent',
        modelMessageId: 'parent-model',
        name: 'task',
        args: {},
        presentation: 'hidden',
      },
      {
        type: 'tool.queued',
        toolCallId: 'hidden-read',
        modelMessageId: 'parent-model',
        name: 'read_file',
        args: { path: 'README.md' },
        presentation: 'hidden',
      },
      invocationRecorded('completed-invocation', 'completed-parent'),
      dispatchIntent('completed-invocation', 'completed-child'),
      invocationRecorded('failed-invocation', 'failed-parent'),
      dispatchIntent('failed-invocation', 'failed-child'),
      {
        type: 'tool.finished',
        toolCallId: 'completed-parent',
        name: 'task',
        presentation: 'hidden',
        result: { ok: true, stdout: '', stderr: '', exitCode: 0 },
      } as RuntimeEvent,
      {
        type: 'tool.failed',
        toolCallId: 'failed-parent',
        presentation: 'hidden',
        failure: { kind: 'unknown', message: 'interrupted' },
      } as RuntimeEvent,
    ];
    const history = createKiteRuntimeHistoryClient(historyLogs(events));
    const loaded = await history.loadSession!('ownership-history');
    const tools = loaded.events.filter(
      (event) =>
        event.type === 'tool.queued' ||
        event.type === 'tool.finished' ||
        event.type === 'tool.failed',
    );
    expect(tools.filter((event) => event.toolId === 'completed-parent')).toMatchObject([
      { presentation: 'standalone' },
      { presentation: 'standalone' },
    ]);
    expect(tools.filter((event) => event.toolId === 'failed-parent')).toMatchObject([
      { presentation: 'standalone' },
      { presentation: 'standalone' },
    ]);
    expect(tools.find((event) => event.toolId === 'unproven-parent')).toMatchObject({
      presentation: 'hidden',
    });
    expect(tools.find((event) => event.toolId === 'hidden-read')).toMatchObject({
      presentation: 'hidden',
    });
    expect((await history.loadSession!('ownership-history', 4)).events).toMatchObject([
      { presentation: 'hidden' },
      { presentation: 'hidden' },
      { presentation: 'hidden' },
      { presentation: 'hidden' },
    ]);
  });

  test('does not infer ambiguous or future child ownership and preserves explicit facts', async () => {
    const childId = 'child-ambiguous';
    const events: RuntimeEvent[] = [
      { type: 'subagent.started', subagent: { id: childId, role: 'review', name: 'Review' } },
      invocationRecorded('invocation-1', 'parent-1'),
      dispatchIntent('invocation-1', childId),
      {
        type: 'subagent.started',
        subagent: { id: childId, role: 'review', name: 'Later conflict' },
      },
      invocationRecorded('invocation-2', 'parent-2'),
      dispatchIntent('invocation-2', childId),
      {
        type: 'subagent.started',
        subagent: {
          id: 'explicit-child',
          role: 'review',
          name: 'Explicit',
          parentToolCallId: 'explicit-parent',
        },
      },
    ];
    const history = createKiteRuntimeHistoryClient(historyLogs(events));
    const loaded = await history.loadSession!('ownership-history');
    expect(loaded.events.find((event) => event.type === 'subagent.started')).not.toHaveProperty(
      'parentToolCallId',
    );
    expect(
      loaded.events.find(
        (event) => event.type === 'subagent.started' && event.subagentId === 'explicit-child',
      ),
    ).toMatchObject({
      parentToolCallId: 'explicit-parent',
    });
    expect((await history.loadSession!('ownership-history', 1)).events[0]).not.toHaveProperty(
      'parentToolCallId',
    );
    expect((await history.loadSession!('ownership-history', 4)).events.at(-1)).toMatchObject({
      type: 'subagent.started',
      parentToolCallId: 'parent-1',
    });
  });

  test('keeps persisted list/load behind the Service RuntimeClient history seam', () => {
    const adapter = readFileSync(
      join(import.meta.dir, '../src/runtime-client/history-adapter.ts'),
      'utf8',
    );
    expect(adapter).toContain('createKiteRuntimeHistoryClient');
    expect(adapter).not.toContain('target.listPersistedSessions(');
    expect(adapter).not.toContain('target.loadPersistedSession(');
  });

  test('projects only fixed client-safe session and event DTOs', async () => {
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [
          {
            sessionId: 'session-1',
            name: '',
            updatedAt: 42,
            lastSequence: 1,
          },
        ],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: [
          {
            sessionId: 'session-1',
            sequence: 1,
            eventId: 'event-1',
            createdAt: 42,
            event: {
              type: 'user.message_appended' as const,
              messageId: 'message-1',
              content: 'hello',
            } as RuntimeEvent,
          },
        ],
        hasMore: false,
        observedLastSequence: 1,
      }),
      close: () => undefined,
    };
    const history = createKiteRuntimeHistoryClient(logs);

    expect(await history.listSessions({ limit: 10 })).toEqual({
      entries: [
        {
          sessionId: 'session-1',
          displayName: 'hello',
          needsSmartName: false,
          updatedAt: 42,
          lastSequence: 1,
        },
      ],
      hasMore: false,
    });
    expect(
      await history.listEvents({
        sessionId: 'session-1',
        direction: 'forward',
        limit: 10,
      }),
    ).toMatchObject({
      entries: [
        {
          type: 'user.message_appended',
          summary: 'hello',
          detail: {
            kind: 'message',
            fields: { content: 'hello', message_id: 'message-1' },
          },
        },
      ],
      hasMore: false,
      observedLastSequence: 1,
    });
  });

  test('reads only the requested current session page for ordinary listing', async () => {
    let listCalls = 0;
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => {
        listCalls++;
        if (listCalls > 1) throw new Error('History scanned beyond the requested page.');
        return {
          entries: [{ sessionId: 'recent', name: '', updatedAt: 42, lastSequence: 1 }],
          hasMore: true,
          nextCursor: { updatedAt: 42, sessionId: 'recent' },
        };
      },
      listEvents: () => ({
        entries: [
          {
            sessionId: 'recent',
            sequence: 1,
            eventId: 'event-1',
            createdAt: 42,
            event: {
              type: 'user.message_appended',
              messageId: 'message-1',
              content: 'Recent title',
            } as RuntimeEvent,
          },
        ],
        hasMore: false,
        observedLastSequence: 1,
      }),
      close: () => undefined,
    };

    await expect(createKiteRuntimeHistoryClient(logs).listSessions({ limit: 1 })).resolves.toEqual({
      entries: [
        {
          sessionId: 'recent',
          displayName: 'Recent title',
          needsSmartName: false,
          updatedAt: 42,
          lastSequence: 1,
        },
      ],
      hasMore: true,
      nextCursor: { updatedAt: 42, sessionId: 'recent' },
    });
    expect(listCalls).toBe(1);
  });

  test('searches the first durable user message when the smart display name is truncated', async () => {
    const eventQueries: string[][] = [];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [
          {
            sessionId: 'session-search',
            name: 'restart persistence target ide',
            updatedAt: 42,
            lastSequence: 1,
          },
        ],
        hasMore: false,
      }),
      listEvents: (request) => {
        eventQueries.push([...(request.eventTypes ?? [])]);
        return {
          entries: [
            {
              sessionId: 'session-search',
              sequence: 1,
              eventId: 'event-search',
              createdAt: 42,
              event: {
                type: 'user.message_appended',
                messageId: 'message-search',
                content: 'restart persistence target identity',
              } as RuntimeEvent,
            },
          ],
          hasMore: false,
          observedLastSequence: 1,
        };
      },
      close: () => undefined,
    };

    await expect(
      createKiteRuntimeHistoryClient(logs).listSessions({
        limit: 10,
        query: 'restart persistence target identity',
      }),
    ).resolves.toMatchObject({
      entries: [{ sessionId: 'session-search' }],
      hasMore: false,
    });
    expect(eventQueries).toEqual([['user.message_appended']]);
  });

  test('stops current-format search after the requested result page', async () => {
    let listCalls = 0;
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => {
        listCalls++;
        if (listCalls > 1) throw new Error('History searched beyond the result page.');
        return {
          entries: [3, 2, 1].map((index) => ({
            sessionId: `matching-${index}`,
            name: `matching ${index}`,
            updatedAt: index,
            lastSequence: 0,
          })),
          hasMore: true,
          nextCursor: { updatedAt: 1, sessionId: 'matching-1' },
        };
      },
      listEvents: () => {
        throw new Error('Named results do not need message reads.');
      },
      close: () => undefined,
    };
    await expect(
      createKiteRuntimeHistoryClient(logs).listSessions({ limit: 2, query: 'matching' }),
    ).resolves.toMatchObject({
      entries: [{ sessionId: 'matching-3' }, { sessionId: 'matching-2' }],
      hasMore: true,
      nextCursor: { updatedAt: 2, sessionId: 'matching-2' },
    });
    expect(listCalls).toBe(1);
  });

  test('reads every durable page and replays a model completion through the live event vocabulary', async () => {
    const records = Array.from({ length: 401 }, (_, index) => ({
      sessionId: 'long-session',
      sequence: index + 1,
      eventId: `event-${index + 1}`,
      createdAt: index + 1,
      event:
        index === 0
          ? ({
              type: 'model.responded',
              invocationId: 'invocation-1',
              messageId: 'message-1',
              reasoningText: 'durable reasoning',
              text: 'durable answer',
              toolCalls: [],
            } as RuntimeEvent)
          : ({
              type: 'user.message_appended',
              messageId: `message-${index + 1}`,
              content: `message ${index + 1}`,
            } as RuntimeEvent),
    }));
    const calls: number[] = [];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [
          {
            sessionId: 'long-session',
            name: 'Long history',
            updatedAt: 10,
            lastSequence: records.length,
            model: { provider: 'provider', name: 'model' },
          },
        ],
        hasMore: false,
      }),
      listEvents: (request) => {
        calls.push(request.afterSequence ?? 0);
        const entries = records.filter(
          (entry) =>
            entry.sequence > (request.afterSequence ?? 0) &&
            (request.beforeSequence === undefined || entry.sequence < request.beforeSequence),
        );
        const page = entries.slice(0, request.limit);
        const last = page.at(-1);
        return {
          entries: page,
          hasMore: entries.length > page.length,
          ...(entries.length > page.length && last ? { nextCursor: last.sequence } : {}),
          observedLastSequence: records.length,
        };
      },
      close: () => undefined,
    };

    const transcript = await createKiteRuntimeHistoryClient(logs).loadSession!('long-session');

    expect(calls).toEqual([0, 200, 400]);
    expect(transcript.session).toMatchObject({
      sessionId: 'long-session',
      model: { provider: 'provider', name: 'model' },
    });
    expect(transcript.events).toHaveLength(403);
    expect(transcript.events.slice(0, 3)).toEqual([
      {
        type: 'reasoning.activity',
        requestId: 'invocation-1',
        state: 'completed',
        segmentId: 'history-reasoning-ofjb0x',
        text: 'durable reasoning',
      },
      { type: 'model.text_delta', requestId: 'invocation-1', text: 'durable answer' },
      {
        type: 'model.responded',
        requestId: 'invocation-1',
        messageId: 'message-1',
        toolCallCount: 0,
        summary: 'durable answer',
      },
    ]);
    expect(transcript.records[0]?.identity).toEqual({
      runId: 'legacy-run-1',
      taskId: 'legacy-task-1',
      turnId: 'legacy-turn-1',
    });
    expect(transcript.records[1]?.identity).toEqual({
      runId: 'legacy-run-2',
      taskId: 'legacy-task-2',
      turnId: 'legacy-turn-2',
    });
    expect(transcript.records[1]?.identity).not.toEqual(transcript.records[0]?.identity);
    const pinned = await createKiteRuntimeHistoryClient(logs).loadSession('long-session', 200);
    expect(pinned.session.lastSequence).toBe(200);
    expect(pinned.records).toEqual(transcript.records.slice(0, 200));
    expect(pinned.events).toHaveLength(202);
    await expect(
      createKiteRuntimeHistoryClient(logs).loadSession('long-session', 402),
    ).rejects.toThrow('snapshot sequence');
  });

  test('backfills pre-admission presentation facts from the following lifecycle identity', async () => {
    const events: RuntimeEvent[] = [
      { type: 'user.message_appended', messageId: 'message-1', content: 'hello' },
      { type: 'task.started', taskId: 'task-1', userGoal: 'hello', turnId: 'turn-1' },
      { type: 'turn.started', turnId: 'turn-1' },
      { type: 'model.requested', requestId: 'request-1' },
    ];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [{ sessionId: 'joined-session', name: '', updatedAt: 42, lastSequence: 4 }],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: events.map((event, index) => ({
          sessionId: 'joined-session',
          sequence: index + 1,
          eventId: `event-${index + 1}`,
          createdAt: 42 + index,
          event,
        })),
        hasMore: false,
        observedLastSequence: 4,
      }),
      close: () => undefined,
    };

    const transcript = await createKiteRuntimeHistoryClient(logs).loadSession('joined-session');

    expect(transcript.records[0]?.identity).toEqual({
      runId: 'turn-1',
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    expect(transcript.records[3]?.identity).toEqual(transcript.records[0]?.identity);
  });

  test('replays exact durable Turn timestamps and omits absent legacy times', async () => {
    const events: RuntimeEvent[] = [
      { type: 'turn.started', turnId: 'turn-1' },
      { type: 'model.requested', requestId: 'request-1' },
      { type: 'turn.completed', turnId: 'turn-1' },
    ];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [{ sessionId: 'timed-session', name: '', updatedAt: 42, lastSequence: 3 }],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: events.map((event, index) => ({
          sessionId: 'timed-session',
          sequence: index + 1,
          eventId: `event-${index + 1}`,
          createdAt: 42 + index,
          ...(index === 1 ? {} : { occurredAt: `2026-09-29T01:02:0${index + 1}.000Z` }),
          event,
        })),
        hasMore: false,
        observedLastSequence: 3,
      }),
      close: () => undefined,
    };
    const transcript = await createKiteRuntimeHistoryClient(logs).loadSession('timed-session');
    expect(transcript.records[0]).toMatchObject({
      occurredAt: '2026-09-29T01:02:01.000Z',
      identity: { turnId: 'turn-1' },
      events: [{ type: 'turn.started', turnId: 'turn-1' }],
    });
    expect(transcript.records[1]).not.toHaveProperty('occurredAt');
    expect(transcript.records[2]).toMatchObject({
      occurredAt: '2026-09-29T01:02:03.000Z',
      events: [{ type: 'turn.terminal', turnId: 'turn-1', status: 'completed' }],
    });
  });

  test('does not bind a planning prompt to the predecessor turn carried by task.started', async () => {
    const events: RuntimeEvent[] = [
      {
        type: 'task.started',
        taskId: 'task-new',
        userGoal: 'plan this',
        // Planning admits the Task while the State still exposes the
        // predecessor Turn. The following turn.started is authoritative for
        // the newly submitted prompt.
        turnId: 'turn-predecessor',
      },
      { type: 'planning.entered', taskId: 'task-new', source: 'user_command' },
      { type: 'user.message_appended', messageId: 'message-new', content: 'plan this' },
      { type: 'turn.started', turnId: 'turn-new' },
      { type: 'model.requested', requestId: 'request-new' },
    ];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [{ sessionId: 'planning-identity', name: '', updatedAt: 42, lastSequence: 5 }],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: events.map((event, index) => ({
          sessionId: 'planning-identity',
          sequence: index + 1,
          eventId: `event-${index + 1}`,
          createdAt: 42 + index,
          event,
        })),
        hasMore: false,
        observedLastSequence: 5,
      }),
      close: () => undefined,
    };

    const transcript = await createKiteRuntimeHistoryClient(logs).loadSession('planning-identity');

    expect(transcript.records[2]?.identity).toEqual({
      runId: 'turn-new',
      taskId: 'task-new',
      turnId: 'turn-new',
    });
    expect(transcript.records[2]?.identity?.turnId).not.toBe('turn-predecessor');
    expect(transcript.records[4]?.identity).toEqual(transcript.records[2]?.identity);
  });

  test('does not inherit the previous active Turn for a successor prompt', async () => {
    const events: RuntimeEvent[] = [
      { type: 'turn.started', turnId: 'turn-old' },
      { type: 'turn.completed', turnId: 'turn-old' },
      { type: 'user.message_appended', messageId: 'message-successor', content: 'continue' },
      { type: 'turn.started', turnId: 'turn-successor' },
      { type: 'model.requested', requestId: 'request-successor' },
    ];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [{ sessionId: 'successor-identity', name: '', updatedAt: 42, lastSequence: 5 }],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: events.map((event, index) => ({
          sessionId: 'successor-identity',
          sequence: index + 1,
          eventId: `event-${index + 1}`,
          createdAt: 42 + index,
          event,
        })),
        hasMore: false,
        observedLastSequence: 5,
      }),
      close: () => undefined,
    };

    const transcript = await createKiteRuntimeHistoryClient(logs).loadSession('successor-identity');

    expect(transcript.records[2]?.identity).toEqual({
      runId: 'turn-successor',
      turnId: 'turn-successor',
    });
    expect(transcript.records[2]?.identity?.turnId).not.toBe('turn-old');
  });

  test('marks an unmatched durable turn as requiring restart recovery', async () => {
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [{ sessionId: 'interrupted-session', name: '', updatedAt: 42, lastSequence: 1 }],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: [
          {
            sessionId: 'interrupted-session',
            sequence: 1,
            eventId: 'interrupted-turn',
            createdAt: 42,
            event: { type: 'turn.started', turnId: 'turn-interrupted' },
          },
        ],
        hasMore: false,
        observedLastSequence: 1,
      }),
      close: () => undefined,
    };

    await expect(
      createKiteRuntimeHistoryClient(logs).loadSession!('interrupted-session'),
    ).resolves.toMatchObject({ recovery: 'restart_required' });
  });

  test('lists known compatibility sessions and imports only the selected session before replay', async () => {
    let imported = false;
    let importCalls = 0;
    const source = (): RuntimeLogQueryPort<RuntimeEvent> => ({
      listSessions: () => ({
        entries: imported
          ? [
              {
                sessionId: 'legacy-session',
                name: '',
                updatedAt: 20,
                lastSequence: 1,
              },
            ]
          : [],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: imported
          ? [
              {
                sessionId: 'legacy-session',
                sequence: 1,
                eventId: 'legacy-event-1',
                createdAt: 20,
                event: {
                  type: 'user.message_appended',
                  messageId: 'legacy-message-1',
                  content: 'legacy prompt',
                } as RuntimeEvent,
              },
            ]
          : [],
        hasMore: false,
        observedLastSequence: imported ? 1 : 0,
      }),
      close: () => undefined,
    });
    const history = createKiteRuntimeHistoryClient(source, {
      listSessions: () => [
        {
          threadId: 'legacy-session',
          name: 'Legacy session',
          updatedAt: 20,
          needsSmartName: false,
        },
      ],
      importSession: (sessionId) => {
        importCalls += 1;
        expect(sessionId).toBe('legacy-session');
        imported = true;
        return { status: 'imported' };
      },
    });

    await expect(history.listSessions({ limit: 10, query: 'legacy' })).resolves.toEqual({
      entries: [
        {
          sessionId: 'legacy-session',
          displayName: 'Legacy session',
          needsSmartName: false,
          updatedAt: 20,
          lastSequence: 0,
        },
      ],
      hasMore: false,
    });
    expect(imported).toBe(false);

    const transcript = await history.loadSession('legacy-session');
    expect(importCalls).toBe(1);
    expect(transcript.session).toMatchObject({
      sessionId: 'legacy-session',
      displayName: 'legacy prompt',
      needsSmartName: false,
      lastSequence: 1,
    });
    expect(transcript.events).toEqual([
      {
        type: 'user.message',
        messageId: 'legacy-message-1',
        kind: 'task',
        text: 'legacy prompt',
      },
    ]);
  });

  test('keeps observer History current-format and never invokes compatibility import', async () => {
    let listCalls = 0;
    let eventCalls = 0;
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => {
        listCalls += 1;
        return { entries: [], hasMore: false };
      },
      listEvents: () => {
        eventCalls += 1;
        return {
          entries: [],
          hasMore: false,
          observedLastSequence: 0,
        };
      },
      close: () => undefined,
    };

    const history = createKiteRuntimeObserverHistoryClient(logs);

    await expect(history.listSessions({ limit: 10 })).resolves.toEqual({
      entries: [],
      hasMore: false,
    });
    await expect(history.loadSession('legacy-only')).rejects.toThrow(
      'Runtime session was not found: legacy-only',
    );
    expect(listCalls).toBeGreaterThan(0);
    expect(eventCalls).toBe(0);
  });

  test('forwards receipt-bearing deletion input through the App storage owner proxy', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'kite-history-delete-'));
    const checkpointPath = join(directory, 'runtime.sqlite');
    const owner = createKiteRuntimeStorageOwner(checkpointPath);
    const receipt = createRuntimeStoredCommandReceipt(
      {
        scopeSessionId: 'delete-session',
        commandId: 'delete-command',
        requestDigest: 'a'.repeat(64),
        targetSessionId: 'delete-session',
        committedAt: 1,
      },
      0,
    );
    try {
      owner.storage.sessions.saveSnapshot(
        'delete-session',
        createInitialAgentState({
          threadId: 'delete-session',
          userId: 'tui',
          workspace: '/workspace',
          projectId: 'project-1',
          canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
          recoveryIdentityKey: 'b'.repeat(64),
          turnId: 'turn-1',
        }),
      );
      owner.storage.sessions.deleteSession('delete-session', {
        expectedRevision: 0,
        commandReceipt: receipt,
      });
      expect(
        owner.storage.commandReceipts.lookup({
          scopeSessionId: 'delete-session',
          commandId: 'delete-command',
          requestDigest: 'a'.repeat(64),
        }),
      ).toEqual({ status: 'replay', receipt });
      expect(owner.storage.sessions.loadSnapshot('delete-session')).toBeNull();
    } finally {
      owner.storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
