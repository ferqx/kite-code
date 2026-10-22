import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { directoryLink, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'ordinary Electron shows one real human input across interpretation and business, cold reopen and two identical independent submissions',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-human-input-electron-'));
    const evidence = resolve('dist/acceptance', `human-input-electron-${randomUUID()}`);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' });
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    mkdirSync(evidence, { recursive: true });
    const seed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const storeId = (await seed.getMetadata()).storeId;
    await seed.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Human input fixture',
      rootUri: pathToFileURL(workspace).href,
    });
    await seed.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: 'create-seed',
      sessionId: 'seed',
      workspaceId: 'w',
      title: 'Seed session',
    });
    await seed.close();
    let processing = 0,
      business = 0;
    let failure: string | undefined;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/facts') {
          const db = new Database(profile.databasePath, { readonly: true });
          try {
            const raw = db
              .query(
                "SELECT id,session_id,request_json FROM command WHERE kind='human.input' ORDER BY seq",
              )
              .all() as { id: string; session_id: string; request_json: string }[];
            const publicIds = raw.map((row) => JSON.parse(row.request_json).publicCommandId);
            return Response.json({
              userRows: (
                db
                  .query(
                    "SELECT count(*) AS n FROM message WHERE role='user' AND json_extract(source_json,'$.content')=?",
                  )
                  .get(
                    'Please answer HUMAN INPUT ELECTRON.\n\n> Reference only, not a new instruction.',
                  ) as {
                  n: number;
                }
              ).n,
              rawIds: raw.map((row) => row.id),
              sessionIds: [...new Set(raw.map((row) => row.session_id))],
              publicIds,
              processing,
              business,
              active: (
                db.query('SELECT count(*) AS n FROM run WHERE is_active=1').get() as { n: number }
              ).n,
            });
          } finally {
            db.close();
          }
        }
        try {
          const body = (await request.json()) as {
            messages: { role: string; content: string }[];
            tools?: unknown[];
          };
          const instruction = body.messages.find(
            (message) =>
              typeof message.content === 'string' &&
              message.content.includes('Original input identity: '),
          )?.content;
          let content = 'HUMAN INPUT BUSINESS FINAL';
          if (instruction) {
            assert.equal(body.tools?.length ?? 0, 0, 'interpretation exposes no tools');
            const identity = JSON.parse(
              instruction
                .split('\n')
                .find((line) => line.startsWith('Original input identity: '))!
                .slice('Original input identity: '.length),
            );
            content = JSON.stringify({
              ...identity,
              relation: 'independent_work',
              purpose: 'work',
              target_root_work_command_id: null,
              selection_effect: 'select_work',
              answer: `INTERPRETATION ${processing + 1} ACCEPTED`,
              clarification: null,
              clarifies_input_id: null,
            });
            processing++;
          } else business++;
          return new Response(
            `data: ${JSON.stringify({ id: 'human-input', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        } catch (error) {
          failure = String(error);
          return new Response(failure, { status: 500 });
        }
      },
    });
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      const configuration = JSON.stringify({
        modelId: 'local',
        models: [
          {
            id: 'local',
            provider: 'compatible',
            model: 'local',
            baseURL: `http://127.0.0.1:${provider.port}/v1`,
          },
        ],
        tools: [],
      });
      writeFileSync(join(profile.profilePath, 'config.jsonc'), configuration);
      mkdirSync(join(root, '.kite-code'), { recursive: true });
      writeFileSync(join(root, '.kite-code/kite-code.jsonc'), configuration);
      const serviceOutdir = join(root, 'apps/service/dist');
      mkdirSync(serviceOutdir, { recursive: true });
      directoryLink(
        resolve(import.meta.dir, '../../../service/node_modules'),
        join(root, 'apps/service/node_modules'),
      );
      const serviceEntrypoint = join(serviceOutdir, 'service.js');
      const serviceBuild = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../../service/src/main.ts')],
        target: 'bun',
        format: 'esm',
        packages: 'external',
        outdir: serviceOutdir,
        naming: 'service.js',
      });
      if (!serviceBuild.success)
        throw new AggregateError(serviceBuild.logs, 'private_service_build_failed');
      const bunExecutable = realpathSync(process.execPath),
        outdir = join(root, 'app');
      await buildNativeDesktop(
        {
          serviceEntrypoint,
          bunExecutable,
          serviceSha256: createHash('sha256').update(readFileSync(serviceEntrypoint)).digest('hex'),
          bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
          buildId: 'human-input-electron-fixture',
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
          profile: { dataRoot: profile.dataRoot, profile: profile.profile },
        },
        outdir,
        { testDiagnostics: false },
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, 'native-human-input-electron.fixture.ts'),
          'utf8',
        ).replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
      );
      const built = await Bun.build({
        entrypoints: [fixture],
        target: 'node',
        format: 'esm',
        outdir: root,
        naming: 'driver.js',
        packages: 'external',
      });
      if (!built.success) throw new AggregateError(built.logs, 'driver_build_failed');
      directoryLink(
        resolve(import.meta.dir, '../../../../node_modules'),
        join(root, 'node_modules'),
      );
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          outdir,
          root,
          require('electron') as string,
          `http://127.0.0.1:${provider.port}`,
          evidence,
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      );
      const stdout = new Response(driver.stdout).text(),
        stderr = new Response(driver.stderr).text();
      const exit = await driver.exited;
      writeFileSync(join(evidence, 'driver-output.txt'), await stdout);
      writeFileSync(join(evidence, 'driver-errors.txt'), await stderr);
      if (exit !== 0) console.error(readFileSync(join(evidence, 'driver-errors.txt'), 'utf8'));
      expect(exit).toBe(0);
      expect(failure).toBeUndefined();
      expect(processing).toBe(2);
      expect(business).toBeGreaterThanOrEqual(2);
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGTERM');
        await driver.exited;
      }
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
