import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { taskQualityPresentedRead } from '../../../../tests/e2e/live/model/agent-task-quality-fixture';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { lookupManagementOutcome, submitManagement } from '../../src/session-management';

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline) throw Error('file_fork_receipt_deadline');
    await Bun.sleep(5);
  }
}
test('actual default Files rebuild Fork false receipt is applied and cold original lookup stays accurate', async () => {
  const root = realpathSync(temporaryDirectory('kite-cli-file-fork-'));
  const workspace = join(root, 'workspace'),
    home = join(root, 'home');
  mkdirSync(workspace);
  privateDirectory(home);
  const userConfiguration = ownedUserConfiguration(home);
  const file = join(workspace, 'original.txt');
  writeFileSync(file, 'original bytes\r\n');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  let requests = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const n = requests++;
      const result = body.messages.filter((m) => m.role === 'tool').at(-1);
      const read = n === 1 && result ? taskQualityPresentedRead(result.content) : undefined;
      if (n === 1 && read?.path !== 'original.txt') throw Error('actual_file_read_result_invalid');
      const call =
        n === 0
          ? { name: 'read_file', input: { path: 'original.txt', max_lines: 1000 } }
          : n === 1
            ? {
                name: 'write_file',
                input: {
                  path: 'original.txt',
                  content: 'actual changed bytes\r\n',
                  base: read!.baseline,
                },
              }
            : null;
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `actual-${n}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${n}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'completed' },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    userConfiguration.path,
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [
        { id: 'files.read', definitionVersion: '5' },
        { id: 'files.write', definitionVersion: '3' },
      ],
    }),
  );
  const service = await launchPairedService({
    entrypoint: join(import.meta.dir, '../../../service/src/main.ts'),
    profile,
    instanceId: 'owned',
    buildId: 'file-fork-receipt',
    apiMajor: 1,
    requiredCapabilities: ['extensions_actions', 'extension_queries'],
    spawnChild: userConfiguration.spawnChild,
  });
  try {
    const client = service.client,
      storeId = service.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'original',
    });
    const mode = await client.getPermissionMode('s', { storeId });
    await client.setPermissionMode('s', {
      expectedStoreId: storeId,
      commandId: 'mode',
      mode: 'full',
      ifRevision: mode.revision,
      makeDefault: false,
      ifDefaultRevision: mode.defaultRevision,
    });
    const trust = await client.getWorkspaceTrust('w', { storeId });
    await client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Read and change the original file.',
    });
    const command = await until(
      () => client.getCommand('work'),
      (c) => c.status === 'applied',
    );
    const runId = (command.receipt as { runId: string }).runId;
    expect(
      (
        await until(
          () => client.getRun(runId),
          (r) => !r.isActive,
        )
      ).status,
    ).toBe('completed');
    expect(readFileSync(file, 'utf8')).toBe('actual changed bytes\r\n');
    const firstView = await client.getView('s');
    const firstFork = await client.forkSession('s', {
      expectedStoreId: storeId,
      commandId: 'first-fork',
      expectedContextSelectionId: firstView.session.contextSelectionId,
      newSessionId: 'parent-fork',
      title: 'Actual first Files snapshot',
    });
    expect(
      firstFork.namespaceReport?.some(
        (r) => r.extensionId === 'builtin.files' && r.mode === 'rebuild',
      ),
    ).toBe(true);
    const view = await client.getView('parent-fork');
    const intent = {
      kind: 'session.fork' as const,
      sessionId: 'parent-fork',
      request: {
        expectedStoreId: storeId,
        commandId: 'fork',
        expectedContextSelectionId: view.session.contextSelectionId,
        newSessionId: 'forked',
        title: 'Forked Files',
      },
    };
    const options = { client, write(_line: string) {} };
    const result = await submitManagement(intent, options);
    expect(result.status).toBe('applied');
    const receipt = result.command!.receipt as {
      omittedExtensionState: boolean;
      namespaceReport: { extensionId: string; mode: string; rebuilt: number }[];
    };
    expect(receipt.omittedExtensionState).toBe(false);
    expect(
      receipt.namespaceReport.some(
        (r) => r.extensionId === 'builtin.files' && r.mode === 'rebuild' && r.rebuilt > 0,
      ),
    ).toBe(true);
    expect(result.omittedExtensionState).toBeUndefined();
    expect((await lookupManagementOutcome(intent, options)).status).toBe('applied');
    expect(await client.getCommand('fork')).toEqual(result.command!);
    for (const changed of [
      { ...receipt, omittedExtensionState: 'false' },
      { ...receipt, namespaceReport: undefined },
      { ...receipt, namespaceReport: [...receipt.namespaceReport, ...receipt.namespaceReport] },
      {
        ...receipt,
        namespaceReport: receipt.namespaceReport.map((r) => ({ ...r, unexpected: true })),
      },
    ]) {
      const invalid = Object.create(client) as typeof client;
      invalid.getCommand = async () =>
        ({ ...result.command!, receipt: changed }) as typeof result.command & {};
      expect((await lookupManagementOutcome(intent, { ...options, client: invalid })).status).toBe(
        'outcome_unknown',
      );
    }
    expect(requests).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe('actual changed bytes\r\n');
  } finally {
    await service.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);
