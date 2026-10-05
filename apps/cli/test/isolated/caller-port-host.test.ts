import { expect, test } from 'bun:test';
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { callerTarget, type TuiCallerRequest } from '@kite-ai/ui/tui';
import { callerDigest, callerRequestDigest } from '../../host/caller-intents';
import { openCallerJournal } from '../../host/caller-journal';
import { createTuiCallerPort } from '../../host/caller-port';
import { createTuiDraftPort } from '../../host/tui-draft-port';
import { openTuiDraftFile } from '../../host/tui-drafts';
import { recoveryProfile, untilRecovery } from '../fixtures/recovery-profile';

test('actual owned caller port freezes large UTF8 Plan, steer, followup and original cancellation; full/corrupt journal prevents all POST', async () => {
  const f = await recoveryProfile(),
    warm = await f.launch(),
    access = acquireProfileAccess({ dataRoot: f.profile.dataRoot, profile: 'owned' });
  const journal = openCallerJournal({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  const drafts = createTuiDraftPort({
    file: openTuiDraftFile({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    }),
    notify: (code) => {
      throw Error(code);
    },
    association: async () => 'current',
  });
  const port = createTuiCallerPort({
    client: warm.client,
    storeId: f.storeId,
    journal,
    drafts: drafts.port,
  });
  const scope = { storeId: f.storeId, sessionId: 'caller', workspaceId: 'w' },
    path = join(f.profile.profilePath, 'ui/caller-intents.json');
  const actualFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === 'POST') posts++;
      return actualFetch(...args);
    },
    { preconnect: actualFetch.preconnect },
  );
  try {
    await warm.client.recoverSession('s', {
      kind: 'session.recover',
      expectedStoreId: f.storeId,
      commandId: 'recover-original',
      decision: 'interrupt',
    });
    await warm.client.createSession({
      expectedStoreId: f.storeId,
      commandId: 'create-caller',
      sessionId: 'caller',
      workspaceId: 'w',
      title: 'Caller',
    });
    const body = '完整中🙂e\u0301\r\n'.repeat(12000);
    drafts.port.read(scope);
    drafts.port.edit(scope, body);
    const start: TuiCallerRequest = {
      kind: 'run.start',
      expectedStoreId: f.storeId,
      commandId: 'large-plan',
      content: body,
      extensionInputs: [
        { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
      ],
    };
    const prepared = await port.prepare(scope, start);
    expect(prepared.draft?.textDigest).toHaveLength(64);
    expect(prepared.request).toEqual(start);
    const initial = await port.submit(prepared);
    expect(['accepted', 'applied']).toContain(initial.phase);
    await untilRecovery(
      async () => (await warm.client.getCommand('large-plan')).status === 'applied',
    );
    const view = await warm.client.getView('caller'),
      run = view.runs.find((r) => r.isActive)!;
    expect(run).toBeDefined();
    const before = posts;
    const same = await port.prepare(scope, start);
    const recovered = await port.submit(same);
    expect(recovered.phase).toBe('applied');
    expect(posts).toBe(before);
    drafts.port.edit(scope, 'NEW_DRAFT_KEEP');
    expect((await port.lookup(prepared, new AbortController().signal)).phase).toBe('applied');
    expect(drafts.port.read(scope)).toBe('NEW_DRAFT_KEEP');
    const inputs: TuiCallerRequest[] = [
      {
        kind: 'input.steer',
        expectedStoreId: f.storeId,
        commandId: 'steer-original',
        content: '精确原Run e\u0301\r\n',
        targetRunId: run.id,
        contextSelectionId: view.session.contextSelectionId,
      },
      {
        kind: 'input.follow_up',
        expectedStoreId: f.storeId,
        commandId: 'queued-original',
        content: '原排队正文🙂',
        afterRunId: run.id,
        contextSelectionId: view.session.contextSelectionId,
      },
      {
        kind: 'command.cancel',
        expectedStoreId: f.storeId,
        commandId: 'cancel-original',
        targetCommandId: 'queued-original',
      },
    ];
    for (const request of inputs) {
      const intent = await port.prepare(scope, request);
      const submitted = await port.submit(intent);
      expect(['accepted', 'applied']).toContain(submitted.phase);
      const sent = posts;
      expect((await port.submit(await port.prepare(scope, request))).phase).not.toBe('unknown');
      expect(posts).toBe(sent);
    }
    const wrongSubject = { ...prepared, subjectId: 'another-subject' };
    expect((await port.lookup(wrongSubject, new AbortController().signal)).phase).toBe('unknown');
    expect(() => journal.prepare(wrongSubject)).toThrow('caller_intent_conflict');
    expect(
      (
        await port.lookup(
          { ...prepared, scope: { ...prepared.scope, workspaceId: 'another-w' } },
          new AbortController().signal,
        )
      ).phase,
    ).toBe('unknown');
    const unchangedPosts = posts;
    for (const bad of [
      { subjectId: 'other-user' },
      { requestDigest: '0'.repeat(64) },
      { subjectId: undefined },
      { requestDigest: undefined },
    ]) {
      globalThis.fetch = Object.assign(
        async (...args: Parameters<typeof fetch>) => {
          const response = await actualFetch(...args);
          if (
            args[1]?.method !== 'POST' &&
            new URL(String(args[0])).pathname === '/v1/commands/large-plan'
          ) {
            const json = await response.json();
            return new Response(JSON.stringify({ ...json, ...bad }), {
              status: response.status,
              headers: response.headers,
            });
          }
          return response;
        },
        { preconnect: actualFetch.preconnect },
      );
      expect((await port.lookup(prepared, new AbortController().signal)).phase).toBe('unknown');
    }
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        if (args[1]?.method === 'POST') posts++;
        return actualFetch(...args);
      },
      { preconnect: actualFetch.preconnect },
    );
    expect(posts).toBe(unchangedPosts);
    const dense = '大正文'.repeat(87000);
    let byteLimit = false;
    for (let i = 0; i < 128; i++) {
      const request: TuiCallerRequest = {
        kind: 'run.start',
        expectedStoreId: f.storeId,
        commandId: `dense-${i}`,
        content: dense,
        extensionInputs: [
          {
            extensionId: 'builtin.skill-workflow',
            definitionVersion: '1',
            input: {
              activations: [
                {
                  key: `original-activation-${i}`,
                  skillId: 'original-skill',
                  input: { original: '中🙂e\u0301' },
                },
              ],
            },
          },
        ],
      };
      const previous = readFileSync(path),
        beforePosts = posts;
      try {
        const full = await port.prepare(scope, request);
        expect(full.request).toEqual(request);
      } catch (error) {
        expect((error as Error).message).toBe('caller_capacity_exceeded');
        expect(posts).toBe(beforePosts);
        expect(readFileSync(path).equals(previous)).toBe(true);
        byteLimit = true;
        break;
      }
    }
    expect(byteLimit).toBe(true);
    for (let i = journal.list().length; i < 128; i++) {
      const request: TuiCallerRequest = {
        kind: 'run.start',
        expectedStoreId: f.storeId,
        commandId: `reserved-${i}`,
        content: 'unsubmitted',
      };
      journal.prepare({
        scope,
        request,
        target: callerTarget(scope, request),
        subjectId: 'local-user',
        bodyDigest: callerDigest(request),
        requestDigest: callerRequestDigest(request),
      });
    }
    const bytes = readFileSync(path),
      sent = posts;
    const next: TuiCallerRequest = {
      kind: 'run.start',
      expectedStoreId: f.storeId,
      commandId: 'overflow',
      content: 'NEVER_POST',
    };
    await expect(port.prepare(scope, next)).rejects.toThrow('caller_intent_limit');
    expect(posts).toBe(sent);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    linkSync(path, `${path}.hard`);
    await expect(port.prepare(scope, next)).rejects.toThrow('caller_journal_unavailable');
    expect(posts).toBe(sent);
    rmSync(`${path}.hard`);
    writeFileSync(path, '{bad');
    await expect(port.prepare(scope, next)).rejects.toThrow('caller_journal_unavailable');
    expect(posts).toBe(sent);
    writeFileSync(path, bytes);
    expect(
      f.rows("SELECT count(*) AS n FROM command WHERE session_id='caller' AND kind='run.start'"),
    ).toEqual([{ n: 1 }]);
    expect(f.rows("SELECT count(*) AS n FROM command WHERE id='overflow'")).toEqual([{ n: 0 }]);
    expect((await warm.client.getCommand('large-plan')).requestDigest).toBe(prepared.requestDigest);
    expect(journal.list()[0]?.intent.request).toEqual(start);
  } finally {
    globalThis.fetch = actualFetch;
    drafts.close();
    journal.close();
    access.lock.release();
    await warm.close();
    f.close();
  }
}, 30000);
