import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { launchPairedService } from '@kite-ai/service/paired';
import { buildNativeDesktop } from '../../scripts/build-native';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, limit = 10000) {
  const deadline = Date.now() + limit;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline) throw Error('default_file_checkpoint_deadline');
    await Bun.sleep(5);
  }
}
type ProviderBody = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string; parameters: unknown } }[];
};

test.skipIf(process.platform !== 'darwin')(
  'actual default paired Electron Files restores with independent Ask and survives code/Fork response loss and owned host SIGKILL without replay',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-checkpoint-browser-'))),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const ownedHome = join(root, 'home');
    mkdirSync(ownedHome);
    const original = Buffer.from(`\uFEFF${'完整原始字节 α\r\n'.repeat(8000)}`),
      originalPath = join(workspace, 'original.txt');
    writeFileSync(originalPath, original);
    const agents =
      'ORIGINAL_CHECKPOINT_AGENT_SOURCE\nUse only the explicitly selected ordinary Files tools.';
    writeFileSync(join(workspace, 'AGENTS.md'), agents);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const requests: ProviderBody[] = [],
      steps = new Map<string, number>();
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request): Promise<Response> {
        const body = (await request.json()) as ProviderBody;
        requests.push(body);
        const user =
          body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
        const key = user.includes('SECOND_ACTUAL_RUN') ? 'second' : 'first',
          step = steps.get(key) ?? 0;
        steps.set(key, step + 1);
        let call: { name: string; input: Json } | null = null;
        if (step === 0)
          call = { name: 'files.read', input: { path: 'original.txt', limit: 10000 } };
        else if (step === 1) {
          const read = body.messages.filter((message) => message.role === 'tool').at(-1);
          if (!read) throw Error('actual_file_read_baseline_missing');
          const actual = JSON.parse(read.content) as { path: string; baseline: Json };
          expect(actual.path).toBe('original.txt');
          call = {
            name: 'files.write',
            input: {
              path: 'original.txt',
              base: actual.baseline,
              content: `${key} actual modified UTF8\r\n`,
            },
          };
        } else if (step === 2)
          call = {
            name: 'files.write',
            input: {
              path: `${key}-created.txt`,
              base: null,
              content: `${key} actual created bytes\r\n`,
            },
          };
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: `files-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame(
            call
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
              : { content: `${key} complete` },
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
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
        tools: [
          { id: 'files.read', definitionVersion: '3' },
          { id: 'files.write', definitionVersion: '2' },
        ],
      }),
    );
    const launch = (id: string) =>
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
        instanceId: id,
        buildId: 'default-checkpoint-main',
        apiMajor: 1,
        requiredCapabilities: [
          'file_recovery',
          'extension_queries',
          'extensions_actions',
          'model_inputs',
          'interactions',
        ],
      });
    let child: Awaited<ReturnType<typeof launch>> | undefined, reader: Store | undefined;
    try {
      child = await launch('live');
      const client = child.client,
        storeId = child.bootstrap.storeId!;
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'Owned Files',
      });
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Actual checkpoint',
      });
      const mode = await client.getPermissionMode('s', { storeId });
      expect(
        (
          await client.setPermissionMode('s', {
            expectedStoreId: storeId,
            commandId: 'mode',
            mode: 'full',
            ifRevision: mode.revision,
            makeDefault: false,
            ifDefaultRevision: mode.defaultRevision,
          })
        ).state,
      ).toBe('applied');
      const trust = await client.getWorkspaceTrust('w', { storeId });
      expect(
        (
          await client.setWorkspaceTrust('w', {
            expectedStoreId: storeId,
            commandId: 'trust',
            trusted: true,
            canonicalIdentity: trust.canonicalIdentity,
            externalReadScopeDigest: trust.externalReadScopeDigest,
            ifRevision: trust.revision,
          })
        ).state,
      ).toBe('applied');
      for (const [commandId, content] of [
        ['first', 'FIRST_ACTUAL_RUN: read then update original and create first file'],
        ['second', 'SECOND_ACTUAL_RUN: read then update original and create second file'],
      ] as const) {
        await client.startRun('s', {
          expectedStoreId: storeId,
          commandId,
          kind: 'run.start',
          content,
        });
        const command = await until(
          () => client.getCommand(commandId),
          (value) => value.status === 'applied',
        );
        const runId = (command.receipt as { runId: string }).runId;
        const run = await until(
          () => client.getRun(runId),
          (value) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status),
        );
        if (run.status !== 'completed')
          console.error(
            'actual_default_files_run_failure',
            JSON.stringify({ command, run, view: await client.getView('s') }),
          );
        expect(run.status).toBe('completed');
      }

      expect(child.bootstrap.capabilities).toContain('file_recovery');
      expect(requests).toHaveLength(8);
      reader = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      const page = await client.listFileCheckpoints('s');
      expect(page.payload.items).toHaveLength(2);
      const commandA = await client.getCommand('first'),
        runA = (commandA.receipt as { runId: string }).runId;
      const point = page.payload.items.find(
        (item) => item.checkpoint.boundary.runId === runA,
      )!.checkpoint;
      const preimage = join(root, 'preimage.bin');
      writeFileSync(preimage, original);
      await child.close();
      child = undefined;
      await reader.close();
      reader = undefined;
      symlinkSync(
        resolve(import.meta.dir, '../../../../node_modules'),
        join(root, 'node_modules'),
        'dir',
      );
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../../service/src/main.ts')],
        target: 'bun',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'service.js',
      });
      expect(built.success).toBe(true);
      const bun = realpathSync(process.execPath),
        service = join(root, 'service.js'),
        outdir = join(root, 'app');
      await buildNativeDesktop(
        {
          serviceEntrypoint: service,
          serviceSha256: hash(readFileSync(service)),
          bunExecutable: bun,
          bunSha256: hash(readFileSync(bun)),
          buildId: 'native-files-fixture',
          apiMajor: 1,
          requiredCapabilities: [
            'sessions',
            'history',
            'commands',
            'permission_controls',
            'file_recovery',
          ],
          profile: { dataRoot: profile.dataRoot, profile: profile.profile },
        },
        outdir,
      );
      const fixture = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../native-file-recovery-electron.fixture.ts')],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'driver.js',
      });
      expect(fixture.success).toBe(true);
      const driver = Bun.spawn(
          [
            realpathSync(Bun.which('node')!),
            join(root, 'driver.js'),
            outdir,
            root,
            createRequire(import.meta.url)('electron') as string,
            point.id,
            originalPath,
            preimage,
            resolve(import.meta.dir, '../../package.json'),
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { HOME: ownedHome, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          },
        ),
        out = new Response(driver.stdout).text(),
        err = new Response(driver.stderr).text(),
        timer = setTimeout(() => driver.kill('SIGKILL'), 45000);
      try {
        const code = await driver.exited,
          stderr = await err;
        if (code) console.error(stderr);
        expect(code).toBe(0);
        console.info((await out).trim());
        expect(await out).toContain('Native Files Electron assertions:');
      } finally {
        clearTimeout(timer);
        driver.kill('SIGKILL');
        await driver.exited;
      }
      expect(requests).toHaveLength(8);
      expect(readFileSync(originalPath)).toEqual(original);
    } finally {
      await reader?.close();
      if (child) await child.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
