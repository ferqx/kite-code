import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createLabelStation, extensionId } from '../../fixtures/extensions/label-station/src/index';

function runId(receipt: unknown) {
  return receipt &&
    typeof receipt === 'object' &&
    !Array.isArray(receipt) &&
    'runId' in receipt &&
    typeof receipt.runId === 'string'
    ? receipt.runId
    : null;
}
test('removing a trusted extension assembly preserves its original records and public history while refusing new actions and permitting ordinary Runs', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-extension-removed-'));
  const effects: unknown[] = [];
  let host: Awaited<ReturnType<typeof openHost>> | undefined;
  async function openHost(installed: boolean) {
    const store = await openSqliteStore({ dataRoot: root, profile: 'removed' });
    const model = createFixedModel([
      [
        { type: 'text_delta', text: 'Unrelated ordinary answer' },
        { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const runtime = createRuntime({
      store,
      model,
      extensions: installed
        ? [
            createLabelStation({
              prefix: 'Original owned resource',
              print: (slip) => effects.push(slip),
            }),
          ]
        : [],
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned-removal' }) },
    });
    const service = await startService({
      runtime,
      profile: { dataRoot: root, name: 'removed', accessKey: 'owned-removal' },
      buildId: 'owned-extension-removal',
      subjectId: 'owner',
    });
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        apiMajor: 1,
        profile: service.bootstrap.profile,
        requiredCapabilities: ['commands', 'sessions', 'extensions_actions'],
      },
    });
    await client.connect();
    return { store, model, runtime, service, client };
  }
  async function closeHost() {
    if (!host) return;
    await host.service.close();
    await host.runtime.close();
    host = undefined;
  }
  async function terminalCommand(id: string) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const command = await host!.client.getCommand(id);
      const view = await host!.client.getView('s');
      if (
        command.status !== 'accepted' &&
        view.executions.every((row) => !['planned', 'dispatching', 'running'].includes(row.status))
      )
        return command;
      if (Date.now() > deadline) throw Error(`removed_extension_command_deadline:${id}`);
      await Bun.sleep(5);
    }
  }
  const records = () =>
    host!.store.listExtensionRecords({
      sessionId: 's',
      extensionId,
      contentType: 'fixture.label-station.receipt',
    });
  try {
    host = await openHost(true);
    const storeId = (await host.store.getMetadata()).storeId;
    await host.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await host.client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Preserved extension history',
    });
    const request = {
      kind: 'extension.invoke' as const,
      expectedStoreId: storeId,
      extensionId,
      actionId: 'issue',
      definitionVersion: '1',
      input: { label: 'Original 😀 <script>inert</script>', ordinal: 1, revision: null },
    };
    await host.client.invokeExtension('s', { ...request, commandId: 'original-issue' });
    expect((await terminalCommand('original-issue')).status).toBe('applied');
    const originalView = await host.client.getView('s');
    const originalRecords = await records();
    expect(originalRecords).toHaveLength(1);
    expect(effects).toHaveLength(1);
    expect(originalView.executions).toHaveLength(2);
    expect(originalView.executions.every((row) => row.status === 'succeeded')).toBe(true);
    expect(host.model.requests).toHaveLength(0);
    const originalEffects = structuredClone(effects);
    await closeHost();

    host = await openHost(false);
    expect((await host.store.getMetadata()).storeId).toBe(storeId);
    expect(await records()).toEqual(originalRecords);
    expect((await host.client.getView('s')).executions).toEqual(originalView.executions);
    expect(JSON.stringify(await host.client.getView('s'))).toContain(
      'Original 😀 <script>inert</script>',
    );
    await expect(
      host.client.invokeExtension('s', { ...request, commandId: 'removed-issue' }),
    ).rejects.toMatchObject({ code: 'action_not_found', status: 404 });
    expect(await host.store.getCommand('removed-issue')).toBeNull();
    expect((await host.client.getView('s')).executions).toEqual(originalView.executions);
    expect(host.model.requests).toHaveLength(0);
    expect(effects).toEqual(originalEffects);
    expect(await records()).toEqual(originalRecords);
    await host.client.startRun('s', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'ordinary-after-removal',
      content: 'Ordinary task without removed extension',
    });
    const ordinary = await terminalCommand('ordinary-after-removal');
    expect(ordinary.status).toBe('applied');
    const ordinaryId = runId(ordinary.receipt);
    expect(ordinaryId).toBeString();
    expect(await host.client.getRun(ordinaryId!)).toMatchObject({ status: 'completed' });
    expect(host.model.requests).toHaveLength(1);
    expect(effects).toEqual(originalEffects);
    expect(await records()).toEqual(originalRecords);
    const finalView = await host.client.getView('s');
    expect(JSON.stringify(finalView)).toContain('Unrelated ordinary answer');
    const finalCommand = await host.client.getCommand('original-issue');
    await closeHost();

    host = await openHost(false);
    const cursor = (await host.store.getMetadata()).lastChangeCursor;
    expect((await host.store.getMetadata()).storeId).toBe(storeId);
    expect(await records()).toEqual(originalRecords);
    expect(await host.client.getView('s')).toEqual(finalView);
    expect(await host.client.getCommand('original-issue')).toEqual(finalCommand);
    expect(await host.store.getCommand('removed-issue')).toBeNull();
    expect((await host.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(host.model.requests).toHaveLength(0);
    expect(effects).toEqual(originalEffects);
    await closeHost();
  } finally {
    await closeHost();
    rmSync(root, { recursive: true, force: true });
  }
});
