import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { launchPairedService } from '@kite-ai/service/paired';
import { createFileRecoveryPort } from '../../host/file-recovery';
import { openFileRecoveryJournal } from '../../host/file-recovery-intents';

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline) throw Error('file_fork_receipt_deadline');
    await Bun.sleep(5);
  }
}
test('actual default file recovery engine seals both legs before POST and cold lookup cannot start Fork', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-cli-file-fork-'));
  const workspace = join(root, 'workspace'),
    home = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(home, { mode: 0o700 });
  const file = join(workspace, 'original.txt');
  writeFileSync(file, 'original bytes\r\n');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let requests = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const n = requests++;
      const read = body.messages.filter((m) => m.role === 'tool').at(-1);
      const call =
        n === 0
          ? { name: 'files.read', input: { path: 'original.txt', limit: 1000 } }
          : n === 1
            ? {
                name: 'files.write',
                input: {
                  path: 'original.txt',
                  content: 'actual changed bytes\r\n',
                  base: JSON.parse(read!.content).baseline,
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
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [
        { id: 'files.read', definitionVersion: '3' },
        { id: 'files.write', definitionVersion: '2' },
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
    spawnChild: (command, { env }) =>
      Bun.spawn([...command], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...env, HOME: home },
      }),
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
    const access = acquireProfileAccess(profile);
    const journal = openFileRecoveryJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
    try {
      const port = createFileRecoveryPort({ client, journal });
      const points = await port.listPoints('s');
      expect(points.payload.items.length).toBe(1);
      const point = points.payload.items[0]!.checkpoint.id;
      const detail = await port.readPoint('s', point);
      expect(detail.preview.payload.files[0]!.status).toBe('restore');
      const initial = await port.begin('s', point, 'both');
      expect(initial.code!.phase).toBe('not_started');
      expect(initial.fork!.phase).toBe('not_started');
      expect(
        JSON.parse(readFileSync(join(profile.profilePath, 'ui/file-recovery-intents.json'), 'utf8'))
          .records[0],
      ).toEqual(initial);
      let current = await port.continue(initial);
      current = await until(
        async () => {
          const command = await client.getCommand(initial.code!.request.commandId);
          const executions = (await client.getView('s')).executions;
          const actionId = (command.receipt as { executionId?: string })?.executionId;
          const card = (
            await client.listInteractions('s', { storeId, state: 'pending' })
          ).interactions.find(
            (i) =>
              i.executionId === actionId ||
              executions.find((e) => e.id === i.executionId)?.parentExecutionId === actionId,
          );
          if (card)
            await client.answerInteraction(card.presentationSessionId, card.id, {
              expectedStoreId: card.originStoreId,
              commandId: 'restore-answer',
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
          return port.lookup(current);
        },
        (i) => i.code!.phase === 'succeeded' || i.code!.phase === 'failed',
      );
      if (current.code!.phase === 'unknown')
        console.error(
          JSON.stringify({
            intent: current,
            command: await client.getCommand(initial.code!.request.commandId),
            status: await client.getFileRestoreStatus(
              's',
              point,
              (initial.code!.request.input as { restoreId: string }).restoreId,
            ),
          }),
        );
      expect(current.code!.phase).toBe('succeeded');
      expect(current.fork!.phase).toBe('not_started');
      expect(readFileSync(file, 'utf8')).toBe('original bytes\r\n');
      const cold = await port.lookup(current);
      expect(cold.fork!.phase).toBe('not_started');
      const done = await port.continue(cold);
      expect(done.fork!.phase).toBe('succeeded');
      expect((await port.continue(done)).fork!.phase).toBe('succeeded');
      expect((await client.getView(done.fork!.request.newSessionId)).session.id).toBe(
        done.fork!.request.newSessionId,
      );
      expect(requests).toBe(3);
    } finally {
      journal.close();
      access.lock.release();
    }
  } finally {
    await service.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);
