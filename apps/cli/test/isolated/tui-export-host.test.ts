import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { launchPairedService } from '@kite-ai/service/paired';
import { terminalSqliteEngineRoot } from '@kite-ai/service/sqlite-release-assets';
import { testToolchainEnvironment } from '../../../../scripts/test-environment';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { verifyTerminalMarkdownAssets } from '../fixtures/terminal-markdown-assets';
import { verifyTerminalPdfAssets } from '../fixtures/terminal-pdf-assets';
import { ptyDeadline } from '../fixtures/tui-pty';

const repository = resolve(import.meta.dir, '../../../..');
for (const mode of ['complete'] as readonly string[]) {
  test(`formal Terminal PTY reads original tail result/reason and exports frozen giant text in the original profile`, async () => {
    const started = Date.now();
    const root =
      process.platform === 'win32'
        ? join(realpathSync(tmpdir()), `kite-tui-host-${randomUUID()}`)
        : realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-host-')));
    if (process.platform === 'win32') privateDirectory(root);
    const workspace = join(root, 'workspace');
    privateDirectory(workspace);
    // Windows candidate admission verifies both this directory and its parent.
    // Keep both owned by the fixture instead of depending on the system Temp ACL.
    const buildRoot = join(root, 'build');
    privateDirectory(buildRoot);
    const candidatePath = join(buildRoot, 'candidate');
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'default' });
    const userConfiguration = ownedUserConfiguration(join(root, 'home'));
    const evidence = join(tmpdir(), `kite-export-evidence-${randomUUID()}`);
    mkdirSync(evidence);
    const stage = (name: string) =>
      appendFileSync(
        join(evidence, 'parent-stages.jsonl'),
        `${JSON.stringify({ stage: name, elapsedMs: Date.now() - started, at: Date.now() })}\n`,
      );
    let passed = false;
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
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
            return JSON.parse(message.content).purpose === 'authorization_review';
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
            ? {
                content: `${'正文'.repeat(1500000)}${tail}`,
                reasoning_content: 'ACTUAL_LOADED_REASON_TAIL',
              }
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
      const build = Bun.spawn(
        [
          process.execPath,
          join(repository, 'scripts/release/terminal.ts'),
          'build',
          '--directory',
          candidatePath,
        ],
        {
          env: {
            ...process.env,
            ...testToolchainEnvironment(),
            ...userConfiguration.homeEnvironment,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [buildOut, buildErr, buildExit] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      if (buildExit !== 0) console.error(buildOut + buildErr);
      expect(buildExit).toBe(0);
      expect(existsSync(join(root, 'home', '.cargo'))).toBe(false);
      expect(existsSync(join(root, 'home', '.rustup'))).toBe(false);
      const candidate = verifyTerminalBundle(candidatePath);
      verifyTerminalMarkdownAssets(repository, candidate.root);
      const artifact = candidate.artifact;
      await verifyTerminalPdfAssets({
        candidate: candidate.root,
        executable: artifact.executable,
        scratch: join(root, 'pdf-probe'),
      });
      // Use the verified formal engine before the fixture's first independent DB read.
      const engine = initializeSqliteEngine({
        root: join(candidate.root, terminalSqliteEngineRoot),
        manifestSha256: candidate.manifest.sqlite.manifestSha256,
      });
      expect(engine).toMatchObject({
        qualification: 'selected',
        linkage: candidate.manifest.sqlite.linkage,
        version: candidate.manifest.sqlite.version,
        sourceId: candidate.manifest.sqlite.sourceId,
      });
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
            { id: 'files.write', definitionVersion: '2' },
            { id: 'files.read', definitionVersion: '5' },
          ],
          models: [
            {
              id: 'local',
              provider: 'compatible',
              model: 'fixture',
              baseURL: `${provider.url.href}v1`,
              // This fixture preserves 9MiB input and giant output, not the summary protocol.
              modelCapabilities: { contextWindowTokens: 32_000_000 },
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
      child = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          join(repository, 'apps/cli/test/fixtures/tui-export-driver.ts'),
          JSON.stringify({
            executable: artifact.executable,
            entrypoint: join(candidate.root, candidate.manifest.entries.tui),
            root,
            workspace,
            dataRoot: join(root, 'data'),
            profilePath: profile.profilePath,
            evidence,
            tail,
            bodyText: '正文',
            bodyRepeats: 1500000,
            databasePath: profile.databasePath,
          }),
        ],
        {
          env: { ...process.env, ...userConfiguration.homeEnvironment },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          ...(process.platform === 'win32' ? { ipc: () => {} } : {}),
        },
      );
      const [out, err, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      stage('driver_exit_observed');
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
        expect(database.query("SELECT status FROM run WHERE session_id<>'a'").all()).toEqual(
          mode === 'complete' ? [] : [{ status: 'completed' }],
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
          expect(out).toContain('FULL_TAIL_OBSERVED True');
          expect(out).toContain('EXPORT_FULL_TAIL_REASON_0600');
          expect(out).toContain('TAIL_RESULT_COLLAPSE_EXPAND_ORIGINAL_ARTIFACT_REFS');
          expect(out).toContain('LOADED_REASON_EXPORTED_WITHOUT_SCREEN_TOGGLE');
          expect(completeSource).toBe(true);
          expect(database.query('SELECT count(*) AS n FROM session').get()).toEqual({ n: 1 });
        } else
          expect(
            database.query("SELECT count(*) AS n FROM interaction WHERE state='accepted'").get(),
          ).toEqual({ n: 0 });
      } finally {
        database.close();
      }
      // A new genuine paired owner can acquire the same profile immediately after explicit host exit.
      stage('paired_reopen_started');
      const reopened = await launchPairedService({
        spawnChild: userConfiguration.spawnChild,
        profile,
        ...artifact,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions'],
      });
      stage('paired_reopen_ready');
      await reopened.close();
      stage('paired_reopen_closed');
      expect(calls).toBe(mode === 'complete' ? 2 : 1);
      expect(reviewCalls).toBe(mode === 'complete' ? 0 : 1);
      passed = true;
    } finally {
      try {
        if (child && child.exitCode === null) {
          if (process.platform === 'win32') child.send('export-driver-stop');
          else child.kill('SIGTERM');
          await ptyDeadline(child.exited, 3000, 'export driver did not stop');
        }
      } finally {
        provider.stop(true);
        let cleaned = false;
        try {
          if (passed) {
            rmSync(root, { recursive: true, force: true });
            cleaned = true;
          }
        } finally {
          console.log(
            JSON.stringify({ evidence, calls, reviewCalls, retainedRoot: cleaned ? null : root }),
          );
        }
      }
    }
  }, 90000);
}
