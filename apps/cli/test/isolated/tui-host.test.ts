import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import type { CLIServiceArtifact } from '../../host';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';

const repository = resolve(import.meta.dir, '../../../..');
for (const mode of ['complete', 'cancel', 'eof'] as const) {
  test(`built development TUI actual PTY ${mode} preserves work and owned lifecycle`, async () => {
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let verified = false;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-host-')));
    const workspace = join(root, 'workspace');
    privateDirectory(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    const userConfiguration = ownedUserConfiguration(join(root, 'home'));
    await buildOwnedDaemon(join(root, 'service-artifact'));
    mkdirSync(join(root, 'apps/service'), { recursive: true });
    symlinkSync(
      join(root, 'service-artifact/node_modules/@kite-ai/service'),
      join(root, 'apps/service/dist'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const developmentEntry = join(root, 'development-tui.ts');
    const stopPath = join(root, 'owned-host-stop');
    writeFileSync(
      developmentEntry,
      `import {existsSync} from 'node:fs';import {runDevelopmentTUI as run} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/development/unified-tui.ts')).href)};export async function runDevelopmentTUI(input){const timer=process.platform==='win32'?setInterval(()=>{if(existsSync(${JSON.stringify(stopPath)})){clearInterval(timer);process.emit('SIGTERM')}},10):undefined;try{return await run({...input,root:${JSON.stringify(root)}})}finally{clearInterval(timer)}}`,
    );
    const entrypoint = join(root, 'apps/service/dist/main.js');
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const entrypointSha256 = sha(readFileSync(entrypoint));
    const artifact: CLIServiceArtifact = {
      entrypoint,
      entrypointSha256,
      executable: realpathSync(process.execPath),
      executableSha256: sha(readFileSync(process.execPath)),
      buildId: `development-${entrypointSha256}`,
      apiMajor: 1,
    };
    let calls = 0;
    let reviewCalls = 0;
    let completeSource = false;
    const sourceTail = 'ORIGINAL_SOURCE_NINE_MIB_TAIL';
    if (mode === 'complete')
      writeFileSync(join(workspace, 'source.txt'), `${'中'.repeat(3 * 1024 * 1024)}${sourceTail}`);
    const tail = 'ACTUAL_HOST_VERIFIED_TAIL';
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 64 * 1024 * 1024,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: { role: string; content: string | null }[];
        };
        const review = body.messages.some((message) => {
          if (message.role !== 'user' || !message.content) return false;
          try {
            return JSON.parse(message.content).purpose === 'authorization_check';
          } catch {
            return false;
          }
        });
        if (review) {
          reviewCalls++;
          const chunk = (delta: unknown, finish: string | null) =>
            `data: ${JSON.stringify({ id: 'review', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          return new Response(
            `${chunk({ content: JSON.stringify({ decision: 'ask_user', reason: 'original workspace write requires explicit fixture review' }) }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        const actual = JSON.stringify(body);
        calls++;
        if (calls > 1 && actual.includes(sourceTail)) completeSource = true;
        const delta =
          mode === 'complete' && calls > 1
            ? { content: `${'正文'.repeat(60000)}${tail}` }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: 'write-original',
                    type: 'function',
                    function: {
                      name: mode === 'complete' ? 'read_file' : 'write_file',
                      arguments: JSON.stringify(
                        mode === 'complete'
                          ? { path: 'source.txt' }
                          : { path: 'effect.txt', base: null, content: 'owned effect' },
                      ),
                    },
                  },
                ],
              };
        const chunk = (value: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
        return new Response(
          `${chunk(delta, null)}${chunk({}, mode === 'complete' && calls > 1 ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    try {
      privateDirectory(profile.profilePath);
      // This fixture asserts English labels independently of the host device locale.
      privateDirectory(join(profile.profilePath, 'ui'));
      writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
        mode: 0o600,
      });
      writeFileSync(
        userConfiguration.path,
        JSON.stringify({
          modelId: 'local',
          tools: [
            { id: 'files.write', definitionVersion: '3' },
            { id: 'files.read', definitionVersion: '5' },
          ],
          models: [
            {
              id: 'local',
              provider: 'compatible',
              model: 'fixture',
              baseURL: `${provider.url.href}v1`,
              // This transport fixture consumes the complete nine-MiB source without a summary round.
              modelCapabilities: { contextWindowTokens: 16000000 },
            },
          ],
        }),
        { mode: 0o600 },
      );
      const seed = await launchPairedService({
        spawnChild: userConfiguration.spawnChild,
        profile,
        ...artifact,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions', 'commands', 'permission_controls'],
      });
      try {
        if (seed.bootstrap.dataAvailability !== 'available') throw new Error('seed_unavailable');
        const storeId = seed.bootstrap.storeId;
        await seed.client.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          rootUri: pathToFileURL(workspace).href,
          name: 'Owned workspace',
        });
        await seed.client.createSession({
          expectedStoreId: storeId,
          commandId: 'create-a',
          sessionId: 'a',
          workspaceId: 'w',
          title: 'Owned Session',
        });
        const observed = await seed.client.getWorkspaceTrust('w', { storeId });
        await seed.client.setWorkspaceTrust('w', {
          expectedStoreId: storeId,
          commandId: 'trust',
          canonicalIdentity: observed.canonicalIdentity,
          externalReadScopeDigest: observed.externalReadScopeDigest,
          trusted: true,
          ifRevision: observed.revision,
        });
        const policy = await seed.client.getPermissionMode('a', { storeId });
        await seed.client.setPermissionMode('a', {
          expectedStoreId: storeId,
          commandId: 'ask',
          mode: mode === 'complete' ? 'accept_edits' : 'auto',
          ifRevision: policy.revision,
          makeDefault: false,
          ifDefaultRevision: policy.defaultRevision,
        });
      } finally {
        await seed.close();
      }
      const child = Bun.spawn(
        [
          process.execPath,
          join(repository, 'apps/cli/test/fixtures/tui-host-pty.ts'),
          JSON.stringify({
            mode,
            root,
            workspace,
            dataRoot: join(root, 'data'),
            databasePath: profile.databasePath,
            entrypoint: developmentEntry,
            serviceEntry: entrypoint,
            evidence: `${root}.pty.log`,
            stopPath,
            tail,
          }),
        ],
        {
          env: { ...process.env, ...userConfiguration.homeEnvironment },
          stdout: 'pipe',
          stderr: 'pipe',
          ...(process.platform === 'win32' ? { ipc() {} } : {}),
        },
      );
      driver = child;
      const [out, err, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) console.error(err);
      expect(exit).toBe(0);
      expect(err).toBe('');
      expect(out).toContain('HOST_EXIT 0');
      expect(out).toContain('OWNED_SERVICE_STOPPED');
      if (mode === 'eof') expect(out).toContain('EOF_WAITING_ZERO_APPROVAL');
      expect(existsSync(join(workspace, 'effect.txt'))).toBe(false);
      expect(calls).toBe(mode === 'complete' ? 2 : 1);
      expect(reviewCalls).toBe(mode === 'complete' ? 0 : 1);
      const database = new Database(profile.databasePath, { readonly: true });
      try {
        const runs = database.query("SELECT status FROM run WHERE session_id='a'").all();
        expect(database.query("SELECT status FROM run WHERE session_id<>'a'").all()).toEqual([]);
        // Auto checks now persist one runless Model in the original Session,
        // bound to the actual write target; they create no synthetic child Run.
        expect(
          database
            .query(
              "SELECT c.status AS commandStatus,e.state,e.session_id AS sessionId,e.run_id AS runId,e.child_session_id AS childSessionId,t.session_id AS targetSessionId,t.adapter_id AS targetDefinition,json_extract(e.result_json,'$.content') AS content FROM command c JOIN execution e ON e.origin_command_id=c.id JOIN execution t ON t.id=e.parent_execution_id WHERE c.kind='authorization.check'",
            )
            .all(),
        ).toEqual(
          mode === 'complete'
            ? []
            : [
                {
                  commandStatus: 'applied',
                  state: 'succeeded',
                  sessionId: 'a',
                  runId: null,
                  childSessionId: null,
                  targetSessionId: 'a',
                  targetDefinition: 'files.write',
                  content: JSON.stringify({
                    decision: 'ask_user',
                    reason: 'original workspace write requires explicit fixture review',
                  }),
                },
              ],
        );
        expect(runs).toEqual([
          {
            status: mode === 'complete' ? 'completed' : 'cancelled',
          },
        ]);
        expect(
          database
            .query("SELECT count(*) AS n FROM execution WHERE kind='tool' AND state='succeeded'")
            .get(),
        ).toEqual({ n: mode === 'complete' ? 1 : 0 });
        if (mode === 'complete') {
          expect(out).toContain('FULL_TAIL True');
          expect(completeSource).toBe(true);
          expect(database.query('SELECT count(*) AS n FROM session').get()).toEqual({ n: 2 });
        } else
          expect(
            database.query("SELECT count(*) AS n FROM interaction WHERE state='accepted'").get(),
          ).toEqual({ n: 0 });
      } finally {
        database.close();
      }
      // A new genuine paired owner can acquire the same profile immediately after explicit host exit.
      const reopened = await launchPairedService({
        spawnChild: userConfiguration.spawnChild,
        profile,
        ...artifact,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions'],
      });
      await reopened.close();
      expect(calls).toBe(mode === 'complete' ? 2 : 1);
      expect(reviewCalls).toBe(mode === 'complete' ? 0 : 1);
      verified = true;
    } finally {
      if (driver && driver.exitCode === null) {
        if (process.platform === 'win32') {
          try {
            driver.send('owned-host-stop');
          } catch (error) {
            expect(error).toHaveProperty('code', 'ERR_IPC_CHANNEL_CLOSED');
          }
        } else driver.kill();
        await driver.exited;
      }
      provider.stop(true);
      if (verified) rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
}

test('TUI help/version and nonterminal refusal do not create a profile or launch a Service', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-pure-')));
  try {
    for (const [argv, code, expected] of [
      [['--help'], 0, 'Development TUI'],
      [['--version'], 0, '0.1.0'],
      [['--data-root', join(root, 'never-created')], 1, 'tui_terminal_unavailable'],
    ] as const) {
      const child = Bun.spawn(
        [process.execPath, join(repository, 'apps/cli/host/tui-main.ts'), ...argv],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      const [out, err, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit).toBe(code);
      expect(out + err).toContain(expected);
      expect(existsSync(join(root, 'never-created'))).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
