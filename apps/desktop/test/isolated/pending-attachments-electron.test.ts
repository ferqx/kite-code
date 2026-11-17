import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { directoryLink, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);

test.skipIf(process.platform !== 'darwin')(
  'real cold Electron restart restores private image and file bytes without submitting; accepted revision and removal stay consumed; corrupt bytes fail visibly',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-pending-attachments-electron-'));
    const evidence = resolve(import.meta.dir, '../../../../.cache/pending-attachments-electron');
    mkdirSync(evidence, { recursive: true });
    const configuration = ownedUserConfiguration(root);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' });
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Attachment fixture',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const [sessionId, title] of [
      ['s', 'Attachments A'],
      ['other', 'Attachments B'],
    ])
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `create-${sessionId}`,
        sessionId: sessionId!,
        workspaceId: 'w',
        title: title!,
      });
    await store.close();
    const requests: unknown[] = [];
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/count')
          return new Response(String(requests.length));
        requests.push(await request.json());
        return new Response(
          'data: ' +
            JSON.stringify({
              id: 'attachment-fixture',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'ATTACHMENT RECEIVED' },
                  finish_reason: null,
                },
              ],
            }) +
            '\n\ndata: ' +
            JSON.stringify({
              id: 'attachment-fixture',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }) +
            '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    writeFileSync(
      configuration.path,
      JSON.stringify({
        modelId: 'local',
        models: [
          {
            id: 'local',
            provider: 'compatible',
            model: 'local',
            baseURL: `http://127.0.0.1:${provider.port}/v1`,
          },
        ],
      }),
    );
    const serviceOutdir = join(root, 'apps/service/dist');
    mkdirSync(serviceOutdir, { recursive: true });
    directoryLink(
      resolve(import.meta.dir, '../../../service/node_modules'),
      join(root, 'apps/service/node_modules'),
    );
    const serviceEntrypoint = join(serviceOutdir, 'service.js');
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../../service/src/main.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'external',
      outdir: serviceOutdir,
      naming: 'service.js',
    });
    if (!built.success) throw new AggregateError(built.logs, 'attachment_service_build_failed');
    const bunExecutable = realpathSync(process.execPath);
    const outdir = join(root, 'app');
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    // Ordinary product build: no diagnostic feature switch or testing UI.
    await buildNativeDesktop(
      {
        serviceEntrypoint,
        bunExecutable,
        serviceSha256: sha(serviceEntrypoint),
        bunSha256: sha(bunExecutable),
        buildId: 'attachment-electron-fixture',
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      },
      outdir,
    );
    const fixture = readFileSync(
      resolve(import.meta.dir, '../pending-attachments-electron.fixture.ts'),
      'utf8',
    )
      .replace(
        "import { _electron } from 'playwright';",
        `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
      )
      .replace(
        "'./native-root-page.fixture'",
        JSON.stringify(resolve(import.meta.dir, '../native-root-page.fixture.ts')),
      )
      .replace(
        "'./native-model-selection.fixture'",
        JSON.stringify(resolve(import.meta.dir, '../native-model-selection.fixture.ts')),
      );
    writeFileSync(join(root, 'driver.ts'), fixture);
    directoryLink(resolve(import.meta.dir, '../../../../node_modules'), join(root, 'node_modules'));
    const driverBuild = await Bun.build({
      entrypoints: [join(root, 'driver.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'driver.js',
    });
    if (!driverBuild.success)
      throw new AggregateError(driverBuild.logs, 'attachment_driver_build_failed');
    const child = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        join(root, 'driver.js'),
        outdir,
        root,
        require('electron') as string,
        `http://127.0.0.1:${provider.port}`,
        bunExecutable,
        join(profile.profilePath, 'desktop-private/data.sqlite'),
        evidence,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', DEBUG: 'pw:browser' },
      },
    );
    const stdout = new Response(child.stdout).text(),
      stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 150000);
    try {
      const code = await child.exited;
      const output = await stdout,
        errors = await stderr;
      writeFileSync(join(evidence, 'driver.log'), `${output}\n${errors}`);
      writeFileSync(join(evidence, 'provider.json'), JSON.stringify(requests, null, 2));
      if (code !== 0) console.error(errors, output);
      expect(code).toBe(0);
      expect(requests).toHaveLength(1);
      const serialized = JSON.stringify(requests);
      const deliveredImage = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(serialized);
      expect(deliveredImage).not.toBeNull();
      expect(
        createHash('sha256').update(Buffer.from(deliveredImage![1]!, 'base64')).digest('hex'),
      ).toBe('60def254db835fc2b2ba18cce5ed11b64ee24386c1bce2a657da2dbf15c434b7');
      const imported = [
        ...new Bun.Glob('**/input-restart.txt').scanSync(join(workspace, '.kite-inputs')),
      ];
      expect(imported).toHaveLength(1);
      expect(readFileSync(join(workspace, '.kite-inputs', imported[0]!), 'utf8')).toBe(
        'PRIVATE ATTACHMENT BYTES\n',
      );
      expect(output).toContain(
        'pending attachments: cold restart, consume, removal, corruption verified',
      );
      console.info(output.trim());
    } finally {
      clearTimeout(timeout);
      child.kill('SIGKILL');
      await child.exited;
      // Only exact disposable-root descendants qualify for emergency cleanup.
      const owned = String(execFileSync('/bin/ps', ['-axo', 'pid=,command=']))
        .split('\n')
        .filter(
          (line) =>
            line.includes(`--user-data-dir=${join(root, 'electron-data')}`) ||
            line.trim().endsWith(` ${serviceEntrypoint}`),
        )
        .map((line) => Number(line.trim().split(/\s+/)[0]));
      for (const pid of owned) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  240000,
);
