import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];

test('stable directory preserves a real multi-Agent page across followup, spawn, parent compression and cold reads; mailbox gaps require explicit observation recovery', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-collaboration-observation-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = {
    expectedStoreId,
    sessionId: 'root',
    subjectId: 'owner',
    extensionId: 'builtin.task',
  };
  const shared = 'Inspect the same component and preserve the exact assignment. '.repeat(700);
  const assignments = [`${shared}UNIQUE_LEFT_TAIL`, `${shared}UNIQUE_RIGHT_TAIL`];
  const followup = 'Recheck only the left component using the saved original assignment.';
  const summary =
    'Two unnamed collaborators retain independent exact responsibility sources; inspect the directory before following either.';
  let stage = 0,
    foreignStage = 0,
    providerCalls = 0,
    childCalls = 0;
  let a = '',
    b = '',
    c = '',
    foreign = '',
    after = '0',
    upper = '',
    firstAnchor = '',
    floor = '';
  let triggerCompression = false,
    compressed = false;
  let waitFor: string[] = [],
    nextStage = 0;
  const completions = new Set<string>();
  let beforeGapFacts = '';
  const facts = async () =>
    JSON.stringify(
      (await store.listExecutions('root'))
        .filter((e) => e.childSessionId)
        .map((e) => ({ id: e.id, acceptance: e.resultAcceptance })),
    );
  const model: ModelAdapter = {
    async *stream(request) {
      providerCalls++;
      if (request.messages.some((m) => m.content.includes('OBSERVATION_SUMMARY_REQUEST'))) {
        expect(request.tools).toHaveLength(0);
        yield { type: 'text_delta', text: summary };
        yield finish;
        return;
      }
      const last = request.messages.filter((m) => m.role === 'tool').at(-1);
      const encoded = last?.content.includes('Complete artifact body:\n')
        ? last.content.split('Complete artifact body:\n')[1]!
        : last?.content;
      const body = encoded ? JSON.parse(encoded) : null;
      if (request.messages.some((m) => m.role === 'user' && m.content === 'foreign work')) {
        if (foreignStage++ === 0) {
          for (const e of call('spawn_agent', { prompt: 'Foreign direct child' })) yield e;
        } else {
          foreign = body.agent_id;
          yield finish;
        }
        return;
      }
      let events: ModelEvent[];
      if (stage === 100) {
        expect(body.reason).toBe('events');
        after = body.next_seq;
        for (const event of body.events)
          if (event.kind === 'completed') completions.add(event.agent_id);
        if (!waitFor.every((id) => completions.has(id)))
          events = call('wait_agent_events', { after_seq: after, wait_ms: 3000 });
        else {
          stage = nextStage;
          events =
            stage === 3
              ? call('list_agents', { limit: 1 })
              : stage === 6
                ? call('spawn_agent', { prompt: 'Third later collaborator' })
                : call('list_agents', { after_seq: firstAnchor, upper_seq: upper, limit: 1 });
        }
      } else
        switch (stage++) {
          case 0:
            events = call('spawn_agent', { prompt: assignments[0] });
            break;
          case 1:
            a = body.agent_id;
            events = call('spawn_agent', { prompt: assignments[1] });
            break;
          case 2:
            b = body.agent_id;
            waitFor = [a, b];
            nextStage = 3;
            stage = 100;
            events = call('wait_agent_events', { after_seq: after, wait_ms: 3000 });
            break;
          case 3:
            expect(body.items).toHaveLength(1);
            expect(body.items[0].agent_id).toBe(a);
            expect(body.items[0].task_name).toBeNull();
            expect(body.items[0].assignment_source.content).toBe(assignments[0]!);
            firstAnchor = body.next_after_seq;
            upper = body.upper_seq;
            expect(firstAnchor).toBeTruthy();
            triggerCompression = true;
            events = call('list_agents', { limit: 2 });
            break;
          case 4:
            expect(request.messages.some((m) => m.content.includes(summary))).toBe(true);
            stage = 40;
            events = call('list_agents', { limit: 2 });
            break;
          case 40:
            expect(body.items).toHaveLength(2);
            expect(
              body.items.every((i: { task_name: string | null }) => i.task_name === null),
            ).toBe(true);
            expect(body.items[0].assignment_source.content).toBe(assignments[0]!);
            expect(body.items[1].assignment_source.content).toBe(assignments[1]!);
            a = body.items[0].agent_id;
            b = body.items[1].agent_id;
            stage = 41;
            events = call('follow_up_agent', { agent_id: a, content: followup });
            break;
          case 41:
            expect(body).toMatchObject({ accepted: true, agent_id: a, mode: 'new_turn' });
            completions.delete(a);
            waitFor = [a];
            nextStage = 6;
            stage = 100;
            events = call('wait_agent_events', { after_seq: after, wait_ms: 3000 });
            break;
          case 6:
            c = body.agent_id;
            waitFor = [c];
            nextStage = 8;
            stage = 100;
            events = call('wait_agent_events', { after_seq: after, wait_ms: 3000 });
            break;
          case 8:
            expect(body.items.map((i: { agent_id: string }) => i.agent_id)).toEqual([b]);
            expect(body.upper_seq).toBe(upper);
            expect(body.next_after_seq).toBeNull();
            expect(body.items[0].assignment_source.content).toBe(assignments[1]!);
            events = call('list_agents', { agent_ids: [a, b], limit: 2 });
            break;
          case 9:
            expect(body.items.map((i: { agent_id: string }) => i.agent_id)).toEqual([a, b]);
            expect(body.next_after_seq).toBeNull();
            expect(body.items[0].assignment_source.content).toBe(assignments[0]!);
            expect(body.items[0].current_work_source.content).toBe(followup);
            expect(body.items[1].assignment_source.content).toBe(assignments[1]!);
            events = call('list_agents', { agent_ids: [a, foreign], limit: 1 });
            break;
          case 10: {
            expect(body.error.code).toBe('agent_unavailable');
            expect(body).not.toHaveProperty('items');
            const page = await store.listAgentEvents({ ...scope, limit: 1 });
            floor = page.events[0]!.seq;
            const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
            db.run('UPDATE storage_meta SET replay_floor=? WHERE singleton=1', [BigInt(floor)]);
            db.close();
            beforeGapFacts = await facts();
            events = call('wait_agent_events', { after_seq: '0', wait_ms: 0 });
            break;
          }
          case 11:
            expect(body).toMatchObject({
              resume_after_seq: floor,
              error: { code: 'cursor_expired', next_action: 'restart_observation' },
            });
            expect(body).not.toHaveProperty('accepted');
            expect(body).not.toHaveProperty('next_seq');
            expect(await facts()).toBe(beforeGapFacts);
            events = call('wait_agent_events', { after_seq: floor, wait_ms: 0 });
            break;
          case 12:
            expect(body.reason).toBe('events');
            expect(body.events.length).toBeGreaterThan(0);
            expect(BigInt(body.events[0].seq)).toBeGreaterThan(BigInt(floor));
            expect(body.next_seq).toBe(body.events.at(-1).seq);
            expect(await facts()).toBe(beforeGapFacts);
            after = body.next_seq;
            events = call('wait_agent_events', { after_seq: floor, wait_ms: 0 });
            break;
          case 13:
            expect(body.next_seq).toBe(after);
            expect(await facts()).toBe(beforeGapFacts);
            events = [finish];
            break;
          default:
            throw Error(`unexpected observation stage ${stage}`);
        }
      for (const e of events) yield e;
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      childCalls++;
      yield { type: 'text_delta', text: 'Exact completed inspection.' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'parent',
    modelConcurrency: 3,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'general' }],
      }),
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'current' };
      },
    },
    compressor: {
      id: 'observation.summary',
      version: '1',
      async shouldCompress(input) {
        return input.session.id === 'root' && triggerCompression && !compressed;
      },
      async prepare() {
        compressed = true;
        return {
          instructions: 'OBSERVATION_SUMMARY_REQUEST preserve responsibility references',
          snapshot: {},
        };
      },
      async validateSummary(input) {
        return input.summary === summary;
      },
    },
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temp',
      rootUri: pathToFileURL(directory).href,
    });
    for (const sessionId of ['foreign-root', 'root'])
      await runtime.createSession({
        expectedStoreId,
        sessionId,
        workspaceId: 'w',
        subjectId: 'owner',
        commandId: `create-${sessionId}`,
        title: sessionId,
      });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'foreign-root',
      subjectId: 'owner',
      commandId: 'foreign-work',
      request: { kind: 'run.start', content: 'foreign work' },
    });
    await runtime.waitForCommand('foreign-work', { timeoutMs: 5000 });
    expect(foreign).toBeTruthy();
    const originalSelection = (await store.getSession('root'))!.contextSelectionId;
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'Observe exact collaborator identities' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 10000 });
    expect(stage).toBe(14);
    expect(childCalls).toBe(5);
    const selected = await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
    expect(selected.compression).toBeDefined();
    expect(selected.selection.id).toBe(originalSelection);
    const carriers = (await store.listExecutions('root')).filter((e) => e.childSessionId);
    expect(carriers.filter((e) => e.childSessionId === a)).toHaveLength(2);
    const directoryTools = (await store.listExecutions('root')).filter(
      (e) => e.definitionId === 'task.list' && e.status === 'succeeded',
    );
    expect(
      directoryTools.some(
        (e) => (e.result as { modelContent?: { kind: string } }).modelContent?.kind === 'artifact',
      ),
    ).toBe(true);
    await runtime.close();
    const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
    // Directory-only placement above Number precision; no execution/context qualification is fabricated.
    const commands = db
      .query(
        "SELECT id FROM command WHERE session_id='root' AND kind='operation.agent' ORDER BY seq",
      )
      .all() as { id: string }[];
    commands.forEach((command, i) => {
      db.run('UPDATE command SET seq=? WHERE id=?', [9007199254740993n + BigInt(i), command.id]);
    });
    db.run("UPDATE session SET next_seq=9007199254741100 WHERE id='root'");
    db.close();
    const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      const cursor = (await readonly.getMetadata()).lastChangeCursor,
        count = providerCalls,
        childCount = childCalls;
      const coldContext = await readonly.getSelectedContext({ expectedStoreId, sessionId: 'root' });
      expect(coldContext.compression?.id).toBe(selected.compression!.id);
      expect(coldContext.selection.id).toBe(originalSelection);
      const before = JSON.stringify(
        (await readonly.listExecutions('root')).map((e) => e.resultAcceptance),
      );
      const first = await readonly.listStableAgents({ ...scope, limit: 2 });
      expect(first.items.map((i) => i.agentId)).toEqual([a, b]);
      expect(first.nextAfterSeq).not.toBeNull();
      expect(BigInt(first.items[0]!.seq)).toBeGreaterThan(9007199254740992n);
      expect(first.items.map((i) => i.seq)).toEqual(['9007199254740993', '9007199254740994']);
      const last = await readonly.listStableAgents({
        ...scope,
        limit: 2,
        afterSeq: first.nextAfterSeq!,
        upperSeq: first.upperSeq,
      });
      expect(last.items.map((i) => i.agentId)).toEqual([c]);
      expect(last.nextAfterSeq).toBeNull();
      expect(first.items[0]!.assignmentSource.content).toBe(assignments[0]!);
      expect(first.items[0]!.currentWorkSource.content).toBe(followup);
      expect(first.items[1]!.assignmentSource.content).toBe(assignments[1]!);
      const empty = await readonly.listStableAgents({
        ...scope,
        afterSeq: first.upperSeq,
        upperSeq: first.upperSeq,
      });
      expect(empty.items).toHaveLength(0);
      expect(empty.nextAfterSeq).toBeNull();
      for (const [patch, code] of [
        [{ agentIds: [a, foreign] }, 'agent_unavailable'],
        [{ agentIds: [a, 'missing-agent'] }, 'agent_unavailable'],
        [{ agentIds: [a, a] }, 'invalid_request'],
        [{ afterSeq: '01' }, 'invalid_cursor'],
        [{ upperSeq: '9223372036854775807' }, 'invalid_cursor'],
      ] as [Partial<Parameters<typeof readonly.listStableAgents>[0]>, string][]) {
        let failure: unknown;
        try {
          await readonly.listStableAgents({
            ...scope,
            ...patch,
            ...('agentIds' in patch ? { agentIds: [...patch.agentIds!] } : {}),
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code });
      }
      const filteredFromStart = await readonly.listStableAgents({
        ...scope,
        agentIds: [b],
        limit: 1,
      });
      expect(filteredFromStart.items.map((i) => i.agentId)).toEqual([b]);
      expect(filteredFromStart.nextAfterSeq).toBeNull();
      const foreignPage = await readonly.listStableAgents({
        ...scope,
        sessionId: 'foreign-root',
        limit: 1,
      });
      expect(foreignPage.items.map((i) => i.agentId)).toEqual([foreign]);
      const numericCursor = await readonly.listStableAgents({
        ...scope,
        afterSeq: foreignPage.items[0]!.seq,
        limit: 2,
      });
      expect(numericCursor.items.map((i) => i.agentId)).toEqual([a, b]);
      expect(numericCursor.items.every((i) => i.agentId !== foreign)).toBe(true);

      expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(
        JSON.stringify((await readonly.listExecutions('root')).map((e) => e.resultAcceptance)),
      ).toBe(before);
      expect(providerCalls).toBe(count);
      expect(childCalls).toBe(childCount);
    } finally {
      await readonly.close();
    }
  } finally {
    await runtime.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
