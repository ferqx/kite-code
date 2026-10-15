import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentClient } from '@kite-ai/client';
import { createTuiWorkspaceObserver } from '../host/tui-workspace-observer';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kite-workspace-observer-'));
  const path = join(root, 'workspace');
  const expected = {
    storeId: 'store',
    sessionId: 'session',
    workspaceId: 'workspace',
    rootUri: pathToFileURL(path).href,
  };
  const effects: string[] = [];
  const view = {
    storeId: expected.storeId,
    session: { id: expected.sessionId, workspaceId: expected.workspaceId, deletedAt: null },
  };
  const settings = { storeId: 'store', scope: 'user', readSet: {}, errors: [] as string[] };
  const source = {
    getView: async () => view,
    getWorkspace: async () => ({ id: expected.workspaceId, rootUri: expected.rootUri }),
    getModelSettings: async () => settings,
    getCommand: async () => ({ id: 'original-command' }),
    queryExtension: async () => ({ availability: 'unavailable' }),
    observe: async () => effects.push('observe'),
    disposeNetwork: () => effects.push('dispose'),
    startRun: async () => effects.push('run'),
    invokeExtension: async () => effects.push('action'),
    answerInteraction: async () => effects.push('answer'),
    updateModelSettings: async () => effects.push('configuration'),
    setWorkspaceTrust: async () => effects.push('trust'),
    futureUnknownMethod: async () => effects.push('unknown'),
  };
  return {
    root,
    path,
    expected,
    source,
    view,
    settings,
    effects,
    observer: createTuiWorkspaceObserver(source as unknown as AgentClient, expected),
  };
}

test('only missing saved root admits observer; original reads survive while all writes and unknown methods are blocked', async () => {
  const f = await fixture();
  try {
    expect(await f.observer.read('workspace')).toBe(true);
    expect(f.observer.active).toBe(true);
    expect((await f.observer.client.getCommand('original-command')).id).toBe('original-command');
    expect(await Reflect.apply(f.observer.client.queryExtension, f.observer.client, [])).toEqual({
      availability: 'unavailable',
    });
    for (const method of [
      'startRun',
      'invokeExtension',
      'answerInteraction',
      'updateModelSettings',
      'setWorkspaceTrust',
      'futureUnknownMethod',
    ])
      await expect(
        Reflect.apply(Reflect.get(f.observer.client, method), f.observer.client, []),
      ).rejects.toMatchObject({ code: 'workspace_observer_readonly' });
    await Reflect.apply(f.observer.client.observe, f.observer.client, []);
    f.observer.client.disposeNetwork();
    expect(f.effects).toEqual(['observe', 'dispose']);
    // Reappearing files cannot silently turn this admitted recovery process into a writer.
    await mkdir(f.path);
    expect(await f.observer.read('workspace')).toBe(true);
    await expect(
      Reflect.apply(f.observer.client.startRun, f.observer.client, []),
    ).rejects.toMatchObject({ code: 'workspace_observer_readonly' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('existing root, no explicit original Session, and foreign workspace do not qualify', async () => {
  const f = await fixture();
  try {
    expect(
      await createTuiWorkspaceObserver(f.source as unknown as AgentClient, undefined).read(
        'workspace',
      ),
    ).toBe(false);
    expect(await f.observer.read('foreign')).toBe(false);
    await mkdir(f.path);
    expect(await f.observer.read('workspace')).toBe(false);
    expect(f.observer.active).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('foreign saved identity and unrelated broken profile are never converted into observer readiness', async () => {
  const f = await fixture();
  try {
    f.view.storeId = 'foreign';
    await expect(f.observer.read('workspace')).rejects.toMatchObject({
      code: 'workspace_identity_mismatch',
    });
    f.view.storeId = 'store';
    f.settings.errors.push('invalid_configuration');
    await expect(f.observer.read('workspace')).rejects.toMatchObject({
      code: 'configuration_unavailable',
    });
    expect(f.observer.active).toBe(false);
    f.settings.errors.length = 0;
    await writeFile(join(f.root, 'not-directory'), 'file');
    f.expected.rootUri = pathToFileURL(join(f.root, 'not-directory')).href;
    expect(await f.observer.read('workspace')).toBe(false);
    expect(f.observer.active).toBe(false);
    const signal = AbortSignal.abort();
    await expect(f.observer.read('workspace', signal)).rejects.toBeDefined();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
