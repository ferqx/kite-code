import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { directoryLink, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ordinaryHostConfigurationDefaults } from '../../../service/src/configuration-defaults';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
type ProviderMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};
function providerMarker(messages: readonly ProviderMessage[]) {
  const text = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const selected = part as { type?: unknown; text?: unknown };
        return ['text', 'input_text'].includes(String(selected.type)) &&
          typeof selected.text === 'string'
          ? selected.text
          : '';
      })
      .join('');
  };
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    const marker = text(message.content)
      .replace(/\\+_/g, '_')
      .match(/ANOMALY_[A-Z_]+/)?.[0];
    if (marker) return { humanIndex: index, marker };
  }
  throw Error('anomaly_original_user_missing');
}

test('anomaly Provider finds the current original user marker across SDK text parts and Markdown escaping', () => {
  expect(
    providerMarker([
      { role: 'user', content: 'ANOMALY_OLD' },
      { role: 'assistant', content: 'ANOMALY_WRONG' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ANOMALY\\_DISCONNECT' },
          { type: 'text', text: '\\_CONTINUE' },
          { type: 'image_url', image_url: { url: 'ANOMALY_IMAGE' } },
        ],
      },
      { role: 'user', content: 'Runtime observation without a marker' },
      { role: 'tool', content: 'ANOMALY_WRONG_TOOL' },
    ]),
  ).toEqual({ humanIndex: 2, marker: 'ANOMALY_DISCONNECT_CONTINUE' });
  expect(providerMarker([{ role: 'user', content: 'ANOMALY_RECEIPT' }])).toEqual({
    humanIndex: 0,
    marker: 'ANOMALY_RECEIPT',
  });
  expect(() => providerMarker([{ role: 'assistant', content: 'ANOMALY_ASSISTANT_ONLY' }])).toThrow(
    'anomaly_original_user_missing',
  );
});

test.skipIf(process.platform !== 'darwin')(
  'ordinary Electron reconnect, paired SIGKILL and lost receipt continue without replay or external error UI',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-session-anomalies-')),
      home = join(root, 'home'),
      workspace = join(root, 'workspace'),
      effectsDirectory = join(workspace, 'effects'),
      evidence = resolve('dist/acceptance', `session-anomalies-electron-${randomUUID()}`),
      profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' });
    for (const directory of [home, workspace, effectsDirectory, evidence])
      mkdirSync(directory, { recursive: true });
    const userConfiguration = ownedUserConfiguration(home),
      calls: { marker: string; phase: 'held' | 'tool' | 'done'; ordinal: number }[] = [],
      counts: Record<string, number> = {},
      failures: string[] = [],
      providerInputs: { role: string; content?: unknown }[][] = [],
      releases = new Map<string, () => void>();
    const readFacts = () => {
      const db = new Database(profile.databasePath, { readonly: true });
      let facts: Record<string, unknown>;
      try {
        db.run('PRAGMA query_only=ON');
        db.run('PRAGMA busy_timeout=1000');
        facts = {
          commands: db.query('SELECT * FROM command ORDER BY session_id,seq').all(),
          runs: db.query('SELECT * FROM run ORDER BY started_at,id').all(),
          executions: db.query('SELECT * FROM execution ORDER BY id').all(),
          messages: db.query('SELECT * FROM message ORDER BY session_id,seq').all(),
        };
      } finally {
        db.close();
      }
      const journalPath = join(profile.profilePath, 'desktop-private', 'data.sqlite'),
        journal: Record<string, unknown[]> = { caller: [], inputQueue: [], creations: [] };
      if (existsSync(journalPath)) {
        const privateDb = new Database(journalPath, { readonly: true });
        try {
          privateDb.run('PRAGMA busy_timeout=1000');
          privateDb.run('PRAGMA query_only=ON');
          for (const [name, table] of [
            ['caller', 'caller_intents'],
            ['inputQueue', 'input_queue_intents'],
            ['creations', 'creations'],
          ]) {
            if (
              privateDb
                .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                .get(table!)
            )
              journal[name!] = privateDb.query(`SELECT * FROM ${table}`).all();
          }
        } finally {
          privateDb.close();
        }
      }
      const effects = Object.fromEntries(
        readdirSync(effectsDirectory)
          .sort()
          .map((name) => [name, readFileSync(join(effectsDirectory, name), 'utf8')]),
      );
      return { ...facts, journal, provider: { calls, counts }, effects, failures };
    };
    const frame = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'session-anomaly', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/facts') {
          try {
            return Response.json(readFacts());
          } catch (error) {
            const code =
                error && typeof error === 'object' && 'code' in error ? String(error.code) : '',
              temporary = /^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/.test(code);
            return Response.json(
              { error: temporary ? 'anomaly_facts_read_busy' : 'anomaly_facts_read_failed', code },
              { status: temporary ? 503 : 500 },
            );
          }
        }
        if (url.pathname === '/release') {
          const marker = url.searchParams.get('marker') ?? '';
          const release = releases.get(marker);
          release?.();
          releases.delete(marker);
          return Response.json({ marker, released: !!release });
        }
        try {
          const body = (await request.json()) as { messages: ProviderMessage[] };
          providerInputs.push(body.messages.map(({ role, content }) => ({ role, content })));
          const { humanIndex, marker } = providerMarker(body.messages);
          const ordinal = (counts[marker] ?? 0) + 1;
          counts[marker] = ordinal;
          const turn = body.messages.slice(humanIndex + 1),
            callId = `effect_${marker}`,
            toolResults = turn.filter((message) => message.role === 'tool'),
            complete = toolResults.some((message) => message.tool_call_id === callId);
          if (toolResults.length && (!complete || toolResults.length !== 1))
            throw Error('anomaly_original_tool_result_changed');
          if (complete) {
            const paired = turn.filter((message) =>
              message.tool_calls?.some(
                (call) => call.id === callId && call.function.name === 'write_file',
              ),
            );
            if (paired.length !== 1) throw Error('anomaly_original_tool_call_changed');
          }
          const held = ordinal === 1 && ['ANOMALY_DISCONNECT', 'ANOMALY_CRASH'].includes(marker);
          calls.push({ marker, phase: held ? 'held' : complete ? 'done' : 'tool', ordinal });
          const final = () => {
            const delta = complete
              ? { content: `DONE ${marker}` }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: callId,
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: `effects/${marker}.txt`,
                          content: marker,
                          base: null,
                        }),
                      },
                    },
                  ],
                };
            return `${frame(delta, null)}${frame({}, complete ? 'stop' : 'tool_calls')}data: [DONE]\n\n`;
          };
          if (!held)
            return new Response(frame({ role: 'assistant' }, null) + final(), {
              headers: { 'content-type': 'text/event-stream' },
            });
          let cancelled = false;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(frame({ role: 'assistant' }, null)));
                releases.set(marker, () => {
                  if (cancelled) return;
                  controller.enqueue(new TextEncoder().encode(final()));
                  controller.close();
                });
              },
              cancel() {
                cancelled = true;
                releases.delete(marker);
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        } catch (error) {
          failures.push(String(error));
          writeFileSync(
            join(evidence, 'provider-input-failure.json'),
            JSON.stringify({ failures, messagesByRequest: providerInputs }, null, 2),
          );
          return new Response(String(error), { status: 500 });
        }
      },
    });
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let warm: Awaited<ReturnType<typeof launchPairedService>> | undefined;
    try {
      const configuration = JSON.stringify({
        modelId: 'local',
        models: [
          {
            id: 'local',
            provider: 'compatible',
            model: 'local',
            baseURL: `http://127.0.0.1:${provider.port}/v1`,
            modelCapabilities: { contextWindowTokens: 1_000_000 },
          },
        ],
        tools: ordinaryHostConfigurationDefaults(true, true).tools.map(({ id }) => ({
          id,
          enabled: id === 'files.write',
          ...(id === 'files.write' ? { definitionVersion: '2' } : {}),
        })),
      });
      writeFileSync(userConfiguration.path, configuration);
      const serviceOutdir = join(root, 'apps/service/dist');
      mkdirSync(serviceOutdir, { recursive: true });
      directoryLink(
        resolve(import.meta.dir, '../../../service/node_modules'),
        join(root, 'apps/service/node_modules'),
      );
      const serviceEntrypoint = join(serviceOutdir, 'service.js'),
        serviceBuild = await Bun.build({
          entrypoints: [resolve(import.meta.dir, '../../../service/src/main.ts')],
          target: 'bun',
          format: 'esm',
          packages: 'external',
          outdir: serviceOutdir,
          naming: 'service.js',
        });
      if (!serviceBuild.success)
        throw new AggregateError(serviceBuild.logs, 'anomaly_service_build');
      const bunExecutable = realpathSync(process.execPath),
        hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex'),
        artifact = {
          entrypoint: serviceEntrypoint,
          executable: bunExecutable,
          entrypointSha256: hash(serviceEntrypoint),
          executableSha256: hash(bunExecutable),
          buildId: 'native-session-anomalies',
          apiMajor: 1,
        };
      warm = await launchPairedService({
        ...artifact,
        profile,
        instanceId: randomUUID(),
        spawnChild: userConfiguration.spawnChild,
        requiredCapabilities: ['sessions', 'commands', 'permission_controls'],
      });
      const client = warm.client,
        storeId = warm.bootstrap.storeId!;
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'Session anomalies fixture',
        rootUri: pathToFileURL(workspace).href,
      });
      for (const [sessionId, title] of [
        ['disconnect', '断线验证'],
        ['crash', '强杀验证'],
        ['receipt', '回执验证'],
      ]) {
        await client.createSession({
          expectedStoreId: storeId,
          commandId: `create_${sessionId}`,
          sessionId: sessionId!,
          workspaceId: 'w',
          title: title!,
        });
        const mode = await client.getPermissionMode(sessionId!, { storeId });
        expect(
          (
            await client.setPermissionMode(sessionId!, {
              expectedStoreId: storeId,
              commandId: `mode_${sessionId}`,
              mode: 'full',
              ifRevision: mode.revision,
              makeDefault: false,
              ifDefaultRevision: mode.defaultRevision,
            })
          ).state,
        ).toBe('applied');
      }
      const trust = await client.getWorkspaceTrust('w', { storeId });
      expect(
        (
          await client.setWorkspaceTrust('w', {
            expectedStoreId: storeId,
            commandId: 'trust_w',
            trusted: true,
            canonicalIdentity: trust.canonicalIdentity,
            externalReadScopeDigest: trust.externalReadScopeDigest,
            ifRevision: trust.revision,
          })
        ).state,
      ).toBe('applied');
      await warm.close();
      warm = undefined;
      const outdir = join(root, 'app');
      await buildNativeDesktop(
        {
          serviceEntrypoint,
          bunExecutable,
          serviceSha256: artifact.entrypointSha256,
          bunSha256: artifact.executableSha256,
          buildId: artifact.buildId,
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
          profile: { dataRoot: profile.dataRoot, profile: profile.profile },
        },
        outdir,
        { testDiagnostics: false },
      );
      writeFileSync(
        join(evidence, 'metadata.json'),
        JSON.stringify(
          {
            sourceCommit: String(
              execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: resolve(import.meta.dir, '../../../..'),
              }),
            ).trim(),
            sourceFiles: Object.fromEntries(
              [
                'apps/desktop/src/native.tsx',
                'apps/desktop/src/native-tool-messages.tsx',
                'packages/ui/src/desktop/Conversation.tsx',
                'packages/ui/src/desktop/ToolActivity.tsx',
              ].map((path) => [
                path,
                createHash('sha256')
                  .update(readFileSync(resolve(import.meta.dir, '../../../..', path)))
                  .digest('hex'),
              ]),
            ),
            root,
            home,
            workspace,
            profile,
            storeId,
            outdir,
            artifact,
          },
          null,
          2,
        ),
      );
      const driverBuild = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../native-session-anomalies-electron.fixture.ts')],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'driver.js',
      });
      if (!driverBuild.success) throw new AggregateError(driverBuild.logs, 'anomaly_driver_build');
      directoryLink(
        resolve(import.meta.dir, '../../../../node_modules'),
        join(root, 'node_modules'),
      );
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          outdir,
          home,
          require('electron') as string,
          `http://127.0.0.1:${provider.port}`,
          evidence,
          profile.databasePath,
          bunExecutable,
          resolve(import.meta.dir, '../../package.json'),
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      );
      const stdout = new Response(driver.stdout).text(),
        stderr = new Response(driver.stderr).text(),
        timer = setTimeout(() => driver?.kill('SIGTERM'), 210000);
      try {
        const code = await driver.exited;
        writeFileSync(join(evidence, 'driver-output.txt'), await stdout);
        writeFileSync(join(evidence, 'driver-errors.txt'), await stderr);
        writeFileSync(join(evidence, 'final-facts.json'), JSON.stringify(readFacts(), null, 2));
        if (code !== 0)
          console.error(evidence, readFileSync(join(evidence, 'driver-errors.txt'), 'utf8'));
        expect(code).toBe(0);
        expect(failures).toEqual([]);
        expect(readFileSync(join(evidence, 'driver-output.txt'), 'utf8')).toContain(
          'native-session-anomalies-qualified',
        );
      } finally {
        clearTimeout(timer);
      }
    } finally {
      try {
        if (driver && driver.exitCode === null) {
          driver.kill('SIGTERM');
          await driver.exited;
        }
      } finally {
        try {
          await warm?.close();
        } finally {
          provider.stop(true);
          // Retain isolated evidence even after failure; never delete live paths.
          writeFileSync(join(evidence, 'retained-profile.txt'), `${profile.profilePath}\n`);
        }
      }
    }
  },
  240000,
);
