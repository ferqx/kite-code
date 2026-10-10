import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '@kite-ai/agent/extensions';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import type { AgentClient, Message } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > end) throw Error('restored_files_original_run_deadline');
    await Bun.sleep(5);
  }
}
async function history(client: AgentClient, sessionId: string): Promise<Message[]> {
  const view = await client.getView(sessionId),
    messages: Message[] = [];
  let afterSeq = '0';
  for (;;) {
    const page = await client.listMessages(sessionId, {
      afterSeq,
      upperSeq: view.session.nextSeq,
      limit: 200,
    });
    for (const message of page) {
      if (
        message.sessionId !== sessionId ||
        BigInt(message.seq) <= BigInt(afterSeq) ||
        BigInt(message.seq) > BigInt(view.session.nextSeq)
      )
        throw Error('original_file_history_identity_mismatch');
      messages.push(message);
      afterSeq = message.seq;
    }
    if (page.length < 200) return messages;
  }
}
type ProviderBody = { messages: { role: string; content: string }[] };

test('restored Native Files read original write/edit previews and read/write/edit plus Markdown paths through two cold Node consumers without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-restored-files-'))),
    workspace = join(root, 'workspace'),
    ownedHome = join(root, 'home'),
    relativePath = 'space name 雪.txt',
    filePath = join(workspace, relativePath);
  mkdirSync(workspace);
  mkdirSync(ownedHome);
  const original = '\uFEFFfirst\r\nold 雪🙂\r\nlast\n',
    written = original.replace('old 雪🙂', 'written α🙂'),
    edited = written.replace('written α🙂', 'edited 原🌿');
  writeFileSync(filePath, original);
  writeFileSync(join(workspace, 'AGENTS.md'), 'ORIGINAL_RESTORED_FILES_AGENT_SOURCE');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const requests: ProviderBody[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const body = (await request.json()) as ProviderBody,
        step = requests.length;
      requests.push(body);
      let call: { name: string; input: Json } | null = null;
      if ([0, 2, 4].includes(step))
        call = { name: 'files.read', input: { path: relativePath, limit: 100 } };
      else if (step === 1 || step === 3) {
        const read = body.messages.filter((message) => message.role === 'tool').at(-1);
        if (!read) throw Error('original_restored_file_baseline_missing');
        const facts = JSON.parse(read.content) as { path: string; baseline: Json };
        if (facts.path !== relativePath) throw Error('original_restored_file_baseline_path');
        call =
          step === 1
            ? {
                name: 'files.write',
                input: { path: relativePath, base: facts.baseline, content: written },
              }
            : {
                name: 'files.edit',
                input: {
                  path: relativePath,
                  base: facts.baseline,
                  find: 'written α🙂',
                  replace: 'edited 原🌿',
                  occurrences: 1,
                },
              };
      }
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `files-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `original-call-${requests.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : {
                content: `Saved original result. Open \`${relativePath}\` in the current project.`,
              },
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
        { id: 'files.edit', definitionVersion: '2' },
      ],
    }),
    { mode: 0o600 },
  );
  const launch = (instanceId: string) =>
    launchPairedService({
      entrypoint: resolve(import.meta.dir, '../../../service/src/main.ts'),
      spawnChild: (command, { env }) =>
        Bun.spawn([...command], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...env, HOME: ownedHome },
        }),
      profile,
      instanceId,
      buildId: 'original-restored-files',
      apiMajor: 1,
      requiredCapabilities: ['file_recovery', 'context', 'extension_queries', 'interactions'],
    });
  let child: Awaited<ReturnType<typeof launch>> | undefined, reader: Store | undefined;
  try {
    child = await launch('original');
    const client = child.client,
      originalStoreId = child.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: originalStoreId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'Original Files',
    });
    await client.createSession({
      expectedStoreId: originalStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Original file history',
    });
    const mode = await client.getPermissionMode('s', { storeId: originalStoreId });
    expect(
      (
        await client.setPermissionMode('s', {
          expectedStoreId: originalStoreId,
          commandId: 'mode',
          mode: 'full',
          ifRevision: mode.revision,
          makeDefault: false,
          ifDefaultRevision: mode.defaultRevision,
        })
      ).state,
    ).toBe('applied');
    const trust = await client.getWorkspaceTrust('w', { storeId: originalStoreId });
    expect(
      (
        await client.setWorkspaceTrust('w', {
          expectedStoreId: originalStoreId,
          commandId: 'trust',
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
          ifRevision: trust.revision,
        })
      ).state,
    ).toBe('applied');
    await client.startRun('s', {
      expectedStoreId: originalStoreId,
      commandId: 'original-files',
      kind: 'run.start',
      content: 'ORIGINAL_FILES_WORK: read, write, read, edit, read the original file once.',
    });
    const command = await until(
        () => client.getCommand('original-files'),
        (value) => value.status === 'applied',
      ),
      runId = (command.receipt as { runId: string }).runId,
      run = await until(
        () => client.getRun(runId),
        (value) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status),
      );
    expect(run.status).toBe('completed');
    expect(requests).toHaveLength(6);
    expect(readFileSync(filePath, 'utf8')).toBe(edited);
    const view = await client.getView('s'),
      messages = await history(client, 's'),
      tools = messages.filter((message) => message.role === 'tool'),
      executions = await Promise.all(
        view.executions.map((execution) => client.getExecution(execution.id)),
      );
    expect(tools).toHaveLength(5);
    expect(tools.every((message) => message.sourceIds?.length === 1)).toBe(true);
    const toolExecutions = executions.filter((execution) => execution.kind === 'tool');
    expect(toolExecutions.map((execution) => execution.definitionId)).toEqual([
      'files.read',
      'files.write',
      'files.read',
      'files.edit',
      'files.read',
    ]);
    expect(
      toolExecutions.every(
        (execution) =>
          execution.status === 'succeeded' && execution.originStoreId === originalStoreId,
      ),
    ).toBe(true);
    const fork = await client.forkSession('s', {
      expectedStoreId: originalStoreId,
      commandId: 'fork',
      expectedContextSelectionId: view.session.contextSelectionId,
      newSessionId: 'sealed',
      title: 'Same project sealed history',
    });
    expect(fork.command.status).toBe('applied');
    const sealed = await history(client, 'sealed');
    expect(sealed).toHaveLength(messages.length);
    expect(sealed.every((message) => message.originMessage?.storeId === originalStoreId)).toBe(
      true,
    );
    expect(
      sealed.filter((message) => message.role === 'tool').map((message) => message.sourceIds),
    ).toEqual(tools.map((message) => message.sourceIds));
    await child.close();
    expect(await child.exited).toBe(0);
    child = undefined;
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backups') }),
      restored = await restoreProfileBackup({
        profile,
        expectedStoreId: originalStoreId,
        backup,
        intent: 'replace_with_selected_backup',
      });
    expect(restored.storeId).not.toBe(originalStoreId);
    const currentContent = 'EXTERNAL_CURRENT_FILE_BYTES_原🌿\r\n';
    writeFileSync(filePath, currentContent);
    const driver = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../native-restored-file-changes-node.fixture.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'driver.js',
    });
    expect(driver.success).toBe(true);
    for (let cold = 0; cold < 2; cold++) {
      child = await launch(`cold-${cold}`);
      reader = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      const metadata = await reader.getMetadata(),
        inputPath = join(root, 'native-input.json');
      writeFileSync(
        inputPath,
        JSON.stringify({
          bootstrap: child.bootstrap,
          originalStoreId,
          restoredStoreId: restored.storeId,
          run,
          command,
          executions,
          sources: [
            { sessionId: 's', messages },
            { sessionId: 'sealed', messages: sealed },
          ],
          relativePath,
          filePath,
          currentContent,
          protectedRoots: [profile.profilePath],
        }),
        { mode: 0o600 },
      );
      const native = Bun.spawn(
          [realpathSync(Bun.which('node')!), join(root, 'driver.js'), inputPath],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { HOME: ownedHome, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          },
        ),
        output = new Response(native.stdout).text(),
        error = new Response(native.stderr).text(),
        timer = setTimeout(() => native.kill('SIGKILL'), 15000);
      try {
        const code = await native.exited;
        if (code) console.error(await error);
        expect(code).toBe(0);
        const result = JSON.parse(await output);
        expect(result.qualified).toBe(true);
        expect(result.counts).toEqual([
          { sessionId: 's', changes: 2, targets: 5 },
          { sessionId: 'sealed', changes: 2, targets: 5 },
        ]);
        expect(result.opened).toHaveLength(16);
        expect(result.opened.every((item: { path: string }) => item.path === filePath)).toBe(true);
        expect(result.methods.length).toBeGreaterThan(0);
        expect(result.methods.every((method: string) => method === 'GET')).toBe(true);
      } finally {
        clearTimeout(timer);
        if (native.exitCode === null) native.kill('SIGKILL');
        await native.exited;
        await Promise.all([output, error]);
      }
      expect(await reader.getMetadata()).toEqual(metadata);
      expect(requests).toHaveLength(6);
      expect(await child.client.getRun(runId)).toEqual(run);
      expect(await child.client.getCommand('original-files')).toEqual(command);
      expect(readFileSync(filePath, 'utf8')).toBe(currentContent);
      await reader.close();
      reader = undefined;
      await child.close();
      expect(await child.exited).toBe(0);
      child = undefined;
    }
  } finally {
    await reader?.close();
    await child?.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
