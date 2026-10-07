import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { launchPairedService } from '@kite-ai/service/paired';
import { candidate, probe } from '../../fixtures/formal-optional-capabilities/candidate';

function runId(receipt: unknown) {
  return receipt &&
    typeof receipt === 'object' &&
    !Array.isArray(receipt) &&
    'runId' in receipt &&
    typeof receipt.runId === 'string'
    ? receipt.runId
    : null;
}
test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'relocated formal candidate loads native keyring without vault operations; default macOS Shell and ordinary Files/chat use the actual host',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-formal-optional-')),
      home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    let service: Awaited<ReturnType<typeof launchPairedService>> | undefined;
    let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let coldAccess: ReturnType<typeof acquireArtifactAccess> | undefined;
    const requests: { messages: { role: string; content: string }[] }[] = [];
    let fileCalls = 0;
    let shellCalls = 0;
    let shellJobId: string | undefined;
    let shellOutput:
      | Awaited<
          ReturnType<
            Awaited<ReturnType<typeof launchPairedService>>['client']['listExecutionOutput']
          >
        >
      | undefined;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as (typeof requests)[number];
        requests.push(body);
        const shell =
          body.messages.filter((message) => message.role === 'user').at(-1)?.content ===
          'Optional Shell selected';
        if (shell) shellCalls++;
        else fileCalls++;
        const call = shell
          ? shellCalls === 1
            ? {
                name: 'shell.launch',
                input: {
                  key: 'default-shell',
                  command: 'printf default-shell; printf default-stderr >&2',
                  cancellation: 'detached',
                },
              }
            : null
          : fileCalls === 1
            ? {
                name: 'files.write',
                input: { path: 'neighbor.txt', base: null, content: 'ordinary 😀\r\n' },
              }
            : fileCalls === 2
              ? { name: 'files.read', input: { path: 'neighbor.txt' } }
              : null;
        const delta = call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${requests.length}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                },
              ],
            }
          : { content: 'ordinary complete' };
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame(delta, null) + frame({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    try {
      const built = await candidate(root);
      expect(existsSync(join(root, 'original'))).toBe(false);
      const loaded = await probe(built, 'load', home);
      expect(loaded.stderr).toBe('');
      expect(loaded.exit).toBe(0);
      expect(JSON.parse(loaded.stdout)).toMatchObject({ nativeLoaded: true, entryCalls: 0 });
      // Running the operation mode without both explicit CI gates refuses before native entry creation.
      const closed = await probe(built, 'put', home);
      expect(closed.exit).not.toBe(0);
      expect(closed.stderr).toContain('native_smoke_gate_closed');
      const config = (tools: { id: string; definitionVersion: string }[]) =>
        JSON.stringify({
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
          tools,
        });
      const configPath = join(profile.profilePath, 'config.jsonc');
      writeFileSync(configPath, config([{ id: 'shell.launch', definitionVersion: '1' }]), {
        mode: 0o600,
      });
      const b = built.bundle;
      service = await launchPairedService({
        profile,
        entrypoint: join(b.root, b.manifest.entries.service),
        executable: join(b.root, b.manifest.entries.runtime),
        instanceId: 'formal-optional',
        buildId: `terminal-${b.digest}`,
        apiMajor: 1,
        runtimeProtection: { kind: 'terminal.candidate', root: b.root, manifestSha256: b.digest },
        requiredCapabilities: ['sessions', 'commands', 'history', 'permission_controls'],
      });
      const client = service.client,
        storeId = service.bootstrap.storeId!;
      if (process.platform === 'darwin') {
        const facts = await client.getHostStatus();
        expect(facts.execution.shell).toMatchObject({
          configured: true,
          available: true,
          supervision: 'macos_coalition',
          qualification: 'darwin_host_boundary',
        });
        expect(facts.execution.sandbox).toEqual({
          backend: 'macos_seatbelt',
          available: true,
          qualification: 'host_scope',
        });
        expect(facts.release.production).toBeNull();
      }
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'optional',
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
      const mode = await client.getPermissionMode('s', { storeId });
      await client.setPermissionMode('s', {
        expectedStoreId: storeId,
        commandId: 'full',
        mode: 'full',
        makeDefault: false,
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
      });
      await client.startRun('s', {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'no-shell',
        content: 'Optional Shell selected',
      });
      const deadline = Date.now() + 15000;
      let rejected = await client.getCommand('no-shell');
      while (rejected.status === 'accepted') {
        if (Date.now() > deadline) throw Error('optional_command_deadline');
        await Bun.sleep(10);
        rejected = await client.getCommand('no-shell');
      }
      if (process.platform === 'darwin') {
        expect(rejected.status, JSON.stringify(rejected)).toBe('applied');
        const id = runId(rejected.receipt);
        expect(id).toBeString();
        while ((await client.getRun(id!)).isActive) {
          if (Date.now() > deadline) throw Error('default_shell_run_deadline');
          await Bun.sleep(10);
        }
        let jobs = (await client.getView('s')).executions.filter(
          (row) => row.definitionId === 'shell.command',
        );
        while (
          jobs.length !== 1 ||
          ['planned', 'dispatching', 'running'].includes(jobs[0]!.status)
        ) {
          if (Date.now() > deadline) throw Error('default_shell_job_deadline');
          await Bun.sleep(10);
          jobs = (await client.getView('s')).executions.filter(
            (row) => row.definitionId === 'shell.command',
          );
        }
        expect(jobs).toHaveLength(1);
        shellJobId = jobs[0]!.id;
        expect(jobs[0]).toMatchObject({
          status: 'succeeded',
          result: { details: { processTreeStopped: true } },
        });
        const output = await client.listExecutionOutput(jobs[0]!.id, { afterSeq: '0', limit: 200 });
        shellOutput = output;
        expect(
          output.items
            .filter((item) => item.stream === 'stdout')
            .map((item) => item.content)
            .join(''),
        ).toBe('default-shell');
        expect(
          output.items
            .filter((item) => item.stream === 'stderr')
            .map((item) => item.content)
            .join(''),
        ).toBe('default-stderr');
        expect(shellCalls).toBe(2);
      } else {
        expect(rejected.status).toBe('rejected');
        expect(JSON.stringify(rejected)).toContain('shell_unavailable');
        expect(requests).toHaveLength(0);
        expect(
          (await client.getView('s')).executions.filter(
            (row) => row.definitionId === 'shell.command',
          ),
        ).toHaveLength(0);
      }
      expect(existsSync(join(root, 'neighbor.txt'))).toBe(false);
      writeFileSync(
        configPath,
        config([
          { id: 'files.read', definitionVersion: '3' },
          { id: 'files.write', definitionVersion: '2' },
        ]),
        { mode: 0o600 },
      );
      await client.startRun('s', {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'ordinary',
        content: 'Ordinary Files',
      });
      let command = await client.getCommand('ordinary'),
        id = runId(command.receipt),
        run = id ? await client.getRun(id) : null;
      const ordinaryDeadline = Date.now() + 15000;
      while (!run || run.isActive) {
        if (Date.now() > ordinaryDeadline) throw Error('ordinary_deadline');
        await Bun.sleep(10);
        command = await client.getCommand('ordinary');
        id = runId(command.receipt);
        run = id ? await client.getRun(id) : null;
      }
      expect(run.status).toBe('completed');
      expect(command.status).toBe('applied');
      expect(readFileSync(join(root, 'neighbor.txt'), 'utf8')).toBe('ordinary 😀\r\n');
      expect(requests).toHaveLength(3 + shellCalls);
      const ordinaryMessages = requests.at(-1)!.messages;
      const ordinaryInput = ordinaryMessages.reduce(
        (found, row, index) =>
          row.role === 'user' && row.content === 'Ordinary Files' ? index : found,
        -1,
      );
      expect(ordinaryInput).toBeGreaterThanOrEqual(0);
      expect(
        ordinaryMessages.slice(ordinaryInput + 1).filter((row) => row.role === 'tool'),
      ).toHaveLength(2);
      writeFileSync(configPath, config([]), { mode: 0o600 });
      await client.startRun('s', {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'chat',
        content: 'No optional tools',
      });
      const chatDeadline = Date.now() + 15000;
      let chatCommand = await client.getCommand('chat'),
        chatId = runId(chatCommand.receipt),
        chat = chatId ? await client.getRun(chatId) : null;
      while (!chat || chat.isActive) {
        if (Date.now() > chatDeadline) throw Error('chat_deadline');
        await Bun.sleep(10);
        chatCommand = await client.getCommand('chat');
        chatId = runId(chatCommand.receipt);
        chat = chatId ? await client.getRun(chatId) : null;
      }
      expect(chatCommand.status).toBe('applied');
      expect(chat.status).toBe('completed');
      expect(requests).toHaveLength(4 + shellCalls);
      expect(readFileSync(join(root, 'neighbor.txt'), 'utf8')).toBe('ordinary 😀\r\n');
      await service.close();
      service = undefined;
      // Cold source reads use the same verified engine as the relocated candidate Service.
      coldAccess = acquireArtifactAccess({ root: b.root, mode: 'shared' });
      const coldEngine = initializeSqliteEngine({
        root: join(b.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: b.manifest.sqlite.manifestSha256,
      });
      expect(coldEngine.version).toBe(b.manifest.sqlite.version);
      expect(coldEngine.sourceId).toBe(b.manifest.sqlite.sourceId);
      reader = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      const cursor = (await reader.getMetadata()).lastChangeCursor;
      expect((await reader.getCommand('no-shell'))?.status).toBe(
        process.platform === 'darwin' ? 'applied' : 'rejected',
      );
      expect((await reader.getRun(run.id))?.status).toBe('completed');
      expect(
        (await reader.listExecutions('s')).filter((row) => row.definitionId === 'shell.command'),
      ).toHaveLength(process.platform === 'darwin' ? 1 : 0);
      if (shellJobId) {
        expect(await reader.getExecution(shellJobId)).toMatchObject({
          status: 'succeeded',
          result: { details: { processTreeStopped: true } },
        });
        expect(
          await reader.listExecutionOutput({ executionId: shellJobId, afterSeq: '0', limit: 200 }),
        ).toEqual(shellOutput!);
      }
      expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(requests).toHaveLength(4 + shellCalls);
      expect((await reader.getRun(chat.id))?.status).toBe('completed');
      console.log(
        JSON.stringify({
          terminalDigest: b.digest,
          engineManifestSha256: coldEngine.selection.manifestSha256,
          engineSourceId: coldEngine.sourceId,
          nativeLoadOnly: true,
          shell:
            process.platform === 'darwin'
              ? 'default_host_producer_passed'
              : 'unavailable_not_delivered',
          provider: requests.length,
          storeId,
          runId: run.id,
          cursor,
        }),
      );
    } finally {
      await reader?.close();
      coldAccess?.release();
      await service?.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
