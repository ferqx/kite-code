import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { DesktopInput, type InputSubmission } from '../../../apps/desktop/src/input';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('input_test_deadline');
    await Bun.sleep(5);
  }
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-input-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const handle = await launchPairedService({
    entrypoint: join(import.meta.dir, '../../fixtures/unified-agent/desktop-input.ts'),
    profile,
    instanceId: 'input-test',
    buildId: 'input-test',
    apiMajor: 1,
    requiredCapabilities: ['commands', 'inputs', 'sessions'],
  }).catch((error) => {
    rmSync(root, { recursive: true, force: true });
    throw error;
  });
  const client = handle.client,
    expectedStoreId = handle.bootstrap.storeId!;
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  for (const sessionId of ['a', 'b'])
    await client.createSession({
      expectedStoreId,
      sessionId,
      commandId: `create-${sessionId}`,
      title: sessionId,
      workspaceId: 'w',
    });
  return {
    client,
    expectedStoreId,
    profile,
    async close() {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('paired child waiting accepts steer in the original Run and queues followup without premature completion or view retarget', async () => {
  const f = await fixture();
  const states: InputSubmission[] = [];
  const input = new DesktopInput({
    admittedClient: f.client,
    onSubmission: (state) => states.push(state),
  });
  try {
    const start = {
      kind: 'run.start' as const,
      expectedStoreId: f.expectedStoreId,
      commandId: 'work',
      content: 'delegate',
    };
    const first = input.start('a', start);
    expect(input.start('a', { ...start })).toBe(first);
    expect((await first).phase).not.toBe('terminal');
    await until(async () => existsSync(join(f.profile.profilePath, 'child-started')));
    const view = await f.client.getView('a'),
      run = view.runs.find((value) => value.isActive)!;
    const selection = view.session.contextSelectionId;
    const steer = await input.steer('a', {
      kind: 'input.steer',
      expectedStoreId: f.expectedStoreId,
      commandId: 'guide',
      content: 'exact new guide',
      targetRunId: run.id,
      contextSelectionId: selection,
    });
    expect(['accepted', 'applied']).toContain(steer.phase);
    const next = await input.followUp('a', {
      kind: 'input.follow_up',
      expectedStoreId: f.expectedStoreId,
      commandId: 'next',
      content: 'later task',
      afterRunId: run.id,
      contextSelectionId: selection,
    });
    expect(next.phase).toBe('accepted');
    expect((await input.lookup('next')).run).toBeUndefined();
    // Selecting another view belongs to the caller; it neither changes saved intent nor cancels work.
    await f.client.getView('b');
    expect(input.submissions.every((state) => state.sessionId === 'a')).toBe(true);
    expect((await f.client.getRun(run.id)).isActive).toBe(true);
    writeFileSync(join(f.profile.profilePath, 'release-child'), 'release');
    await until(async () => (await input.lookup('next')).phase === 'terminal');
    expect((await input.lookup('work')).run?.status).toBe('completed');
    expect((await input.lookup('guide')).run?.id).toBe(run.id);
    expect((await input.lookup('next')).run?.id).not.toBe(run.id);
    const requests = readFileSync(join(f.profile.profilePath, 'models'), 'utf8');
    expect(requests).toContain('exact new guide');
    expect(requests).toContain('later task');
    expect(readFileSync(join(f.profile.profilePath, 'child-finished'), 'utf8')).toBe('one\n');
    expect(
      states
        .filter((state) => state.phase === 'terminal')
        .every((state) => state.run && !state.run.isActive),
    ).toBe(true);
  } finally {
    input.disposeObserver();
    await f.close();
  }
}, 15000);

test('paired response loss only queries saved command; precise cancel is deduplicated and observer dispose does not stop work', async () => {
  const f = await fixture();
  let mutations = 0,
    cancels = 0;
  const original = f.client.startRun.bind(f.client),
    cancel = f.client.cancelCommand.bind(f.client);
  f.client.startRun = async (...args) => {
    mutations++;
    await original(...args);
    throw new Error('response_lost');
  };
  f.client.cancelCommand = (...args) => {
    cancels++;
    return cancel(...args);
  };
  const input = new DesktopInput({ admittedClient: f.client });
  try {
    const intent = {
      kind: 'run.start' as const,
      expectedStoreId: f.expectedStoreId,
      commandId: 'original',
      content: 'delegate',
    };
    expect((await input.start('a', intent)).phase).toBe('unknown');
    expect((await input.start('a', intent)).phase).toBe('unknown');
    expect(mutations).toBe(1);
    await until(async () => existsSync(join(f.profile.profilePath, 'child-started')));
    expect((await input.lookup('original')).command?.id).toBe('original');
    const one = input.cancel('original', 'cancel-original');
    expect(input.cancel('original', 'new-click-id')).toBe(one);
    expect((await one).intent).toMatchObject({
      expectedStoreId: f.expectedStoreId,
      targetCommandId: 'original',
    });
    expect(cancels).toBe(1);
    await until(async () => (await input.lookup('original')).phase === 'terminal');
    expect((await input.lookup('original')).run?.status).toBe('cancelled');
    f.client.startRun = original;
    const another = new DesktopInput({ admittedClient: f.client });
    await another.start('b', { ...intent, commandId: 'independent', content: 'continue' });
    another.disposeObserver();
    await until(async () =>
      (await f.client.getView('b')).runs.some((run) => run.status === 'completed'),
    );
    expect((await f.client.getView('b')).session.id).toBe('b');
  } finally {
    input.disposeObserver();
    await f.close();
  }
}, 15000);

test('wrong Store and stale targets are known failures; late reply retains frozen original intent and cannot resubmit elsewhere', async () => {
  const f = await fixture();
  const input = new DesktopInput({ admittedClient: f.client });
  try {
    const wrong = await input.start('a', {
      kind: 'run.start',
      expectedStoreId: 'wrong-store',
      commandId: 'wrong',
      content: 'zero work',
    });
    expect(wrong.phase).toBe('failed');
    expect((await f.client.getView('a')).runs).toHaveLength(0);
    const selection = (await f.client.getView('a')).session.contextSelectionId;
    expect(
      (
        await input.steer('a', {
          kind: 'input.steer',
          expectedStoreId: f.expectedStoreId,
          commandId: 'stale',
          targetRunId: 'absent',
          contextSelectionId: selection,
          content: 'zero',
        })
      ).phase,
    ).toBe('failed');
    const original = f.client.startRun.bind(f.client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.client.startRun = async (...args) => {
      const command = await original(...args);
      await gate;
      return command;
    };
    const intent = {
      kind: 'run.start' as const,
      expectedStoreId: f.expectedStoreId,
      commandId: 'late',
      content: 'original content',
    };
    const pending = input.start('a', intent);
    intent.content = 'caller mutated after click';
    await until(async () => existsSync(join(f.profile.profilePath, 'child-started')));
    await f.client.getView('b');
    release();
    expect((await pending).sessionId).toBe('a');
    expect((await pending).intent).toMatchObject({ content: 'original content' });
    expect(() => input.start('b', { ...intent, content: 'original content' })).toThrow(
      'input_identity_conflict',
    );
    expect(Object.isFrozen((await pending).intent)).toBe(true);
    await input.cancel('late', 'cancel-late');
  } finally {
    input.disposeObserver();
    await f.close();
  }
}, 15000);

test('disposing the observer during live child work preserves Service execution, and invalid input or capacity does not hide an intent', async () => {
  const f = await fixture();
  const callbacks: InputSubmission[] = [];
  const input = new DesktopInput({
    admittedClient: f.client,
    maxIntents: 2,
    onSubmission: (state) => callbacks.push(state),
  });
  try {
    const invalid = await input.steer('a', {
      kind: 'input.steer',
      expectedStoreId: f.expectedStoreId,
      commandId: 'empty',
      targetRunId: 'absent',
      contextSelectionId: (await f.client.getView('a')).session.contextSelectionId,
      content: ' ',
    });
    expect(invalid.phase).toBe('failed');
    expect(invalid.error).toBe('invalid_request');
    const request = {
      kind: 'run.start' as const,
      commandId: 'live',
      expectedStoreId: f.expectedStoreId,
      content: 'delegate',
    };
    await input.start('a', request);
    // Equal generated DTO fields in a different property order keep the same identity.
    expect(
      (
        await input.start('a', {
          content: request.content,
          expectedStoreId: request.expectedStoreId,
          commandId: request.commandId,
          kind: request.kind,
        })
      ).command?.id,
    ).toBe('live');
    expect(() => input.start('b', { ...request, commandId: 'over-capacity' })).toThrow(
      'input_intent_limit',
    );
    expect(input.submissions).toHaveLength(2);
    await until(async () => existsSync(join(f.profile.profilePath, 'child-started')));
    const before = callbacks.length;
    input.disposeObserver();
    expect(() => input.start('b', { ...request, commandId: 'disposed' })).toThrow('input_disposed');
    expect((await f.client.getView('a')).runs[0]?.isActive).toBe(true);
    writeFileSync(join(f.profile.profilePath, 'release-child'), 'release');
    await until(async () =>
      (await f.client.getView('a')).runs.some((run) => run.status === 'completed'),
    );
    expect(callbacks).toHaveLength(before);
    expect(readFileSync(join(f.profile.profilePath, 'child-finished'), 'utf8')).toBe('one\n');
  } finally {
    input.disposeObserver();
    await f.close();
  }
}, 15000);
