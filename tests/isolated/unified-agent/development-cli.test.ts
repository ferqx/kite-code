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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { startService } from '@kite-ai/service';
import { launchPairedService } from '@kite-ai/service/paired';
import { openRecoveryJournal } from '../../../apps/cli/host/recovery-journal';
import {
  reserveDaemonEndpoint,
  selectDaemonEndpoint,
} from '../../../apps/service/src/daemon/endpoint';
import { runDevelopmentCLI, selectDevelopmentCLI } from '../../../scripts/development/unified-cli';

const repositoryRoot = realpathSync(join(import.meta.dir, '../../..'));
test('CLI development selection binds only the exact built entry and executable; read-only argv needs no asset or profile', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-dev-selection-')));
  try {
    for (const argv of [
      ['--help'],
      ['--version'],
      ['run', '--task', 'x', '--server', join(root, 'owned.sock')],
      ['resume', '--thread', 'original', '--task', 'x', '--server', join(root, 'owned.sock')],
      [
        'session',
        'rename',
        's',
        '--input',
        JSON.stringify({
          expectedStoreId: 'store',
          commandId: 'rename',
          ifRevision: '0',
          title: 'name',
        }),
        '--server',
        join(root, 'owned.sock'),
      ],
      [
        'context',
        'read',
        's',
        '--input',
        JSON.stringify({ storeId: 'store', contextSelectionId: 'selection' }),
        '--server',
        join(root, 'owned.sock'),
      ],
      ['trace', '/explicit/events.jsonl'],
      ['maintenance', '--help'],
      ['maintenance', 'status', '--data-root', join(root, 'selected'), '--profile', 'maintenance'],
    ]) {
      const selection = selectDevelopmentCLI(argv, root, '/missing-executable');
      expect(selection.artifact).toBeUndefined();
      expect(selection.argv).toEqual(argv);
    }
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
    expect(() => selectDevelopmentCLI(['run', '--task', 'x'], root)).toThrow(
      'development_service_asset_unavailable',
    );
    const entrypoint = join(root, 'apps/service/dist/main.js');
    mkdirSync(join(root, 'apps/service/dist'), { recursive: true });
    writeFileSync(entrypoint, '// exact development fixture\n');
    const selection = selectDevelopmentCLI(['run', '--task', 'x'], root);
    const digest = createHash('sha256').update(readFileSync(entrypoint)).digest('hex');
    expect(selection.artifact).toMatchObject({
      entrypoint,
      entrypointSha256: digest,
      buildId: `development-${digest}`,
      apiMajor: 1,
    });
    expect(selection.artifact!.executable).toBe(realpathSync(process.execPath));
    expect(Object.isFrozen(selection.artifact)).toBe(true);
    expect(selection.profile).toBe('development');
    expect(existsSync(selection.dataRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new finite local vocabulary resolves lazily; shared and invalid argv never read assets', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-dev-lazy-')));
  const json = JSON.stringify;
  const work = {
    kind: 'run.start',
    expectedStoreId: 'store',
    commandId: 'work',
    content: '原文😀\r\n',
  };
  const argvCases = [
    ['work', 's', '--input', json(work)],
    ...[
      {
        kind: 'input.steer',
        content: 'x',
        targetRunId: 'r',
        contextSelectionId: 'selection',
        expectedStoreId: 'store',
        commandId: 'steer',
      },
      {
        kind: 'input.follow_up',
        content: 'x',
        afterRunId: null,
        contextSelectionId: 'selection',
        expectedStoreId: 'store',
        commandId: 'follow',
      },
      {
        kind: 'command.cancel',
        targetCommandId: 'original',
        expectedStoreId: 'store',
        commandId: 'cancel',
      },
      { kind: 'execution.cancel', executionId: 'job', expectedStoreId: 'store', commandId: 'stop' },
    ].map((input) => ['work', 's', '--input', json(input)]),
    [
      'recovery',
      'run',
      's',
      '--input',
      json({
        kind: 'run.resume',
        expectedStoreId: 'store',
        commandId: 'resume',
        runId: 'original',
      }),
    ],
    [
      'recovery',
      'interrupt',
      's',
      '--input',
      json({
        kind: 'session.recover',
        expectedStoreId: 'store',
        commandId: 'interrupt',
        decision: 'interrupt',
      }),
    ],
    [
      'recovery',
      'report',
      's',
      'original-report',
      '--input',
      json({ expectedStoreId: 'store', commandId: 'report' }),
    ],
    ['caller', 'list', 's', '--input', json({ expectedStoreId: 'store', workspaceId: 'w' })],
    ['recovery', 'list', 's', '--input', json({ expectedStoreId: 'store' })],
    [
      'recovery',
      'lookup',
      's',
      '--input',
      json({ expectedStoreId: 'store', commandId: 'original' }),
    ],
    ['files', 'checkpoints', 's'],
    ['files', 'detail', 's', 'a'.repeat(64)],
    ['files', 'restore', 's', 'a'.repeat(64), '--scope', 'both'],
    ['files', 'intents', 's'],
    ['files', 'lookup', 's', '--input', '{}'],
    ['files', 'continue', 's', '--input', '{}'],
  ];
  try {
    for (const argv of argvCases) {
      const local = selectDevelopmentCLI(argv, root, '/missing-executable');
      expect(local.artifact).toBeUndefined();
      expect(Object.isFrozen(local)).toBe(true);
      expect(local.resolveArtifact).toBeDefined();
      expect(() => local.resolveArtifact!()).toThrow('development_service_asset_unavailable');
      const shared = selectDevelopmentCLI(
        [...argv, '--server', join(root, 's.sock')],
        root,
        '/missing-executable',
      );
      expect(shared.artifact).toBeUndefined();
      expect(shared.resolveArtifact).toBeUndefined();
    }
    for (const argv of [
      ['work', 's', '--input', json({ ...work, kind: 'extension.invoke' })],
      [
        'caller',
        'list',
        's',
        '--input',
        json({ expectedStoreId: 'store', workspaceId: 'w', extra: true }),
      ],
      ['recovery', 'lookup', 's', '--input', '{}'],
      ['files', 'restore', 's', 'a'.repeat(64), '--scope', 'all'],
      ['files', 'detail', 's', 'not-a-point'],
    ])
      expect(() => selectDevelopmentCLI(argv, root, '/missing-executable')).toThrow();
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
    const entry = join(root, 'apps/service/dist/main.js');
    mkdirSync(join(root, 'apps/service/dist'), { recursive: true });
    writeFileSync(entry, '// exact lazy first');
    const lazy = selectDevelopmentCLI(argvCases[0]!, root);
    const first = lazy.resolveArtifact!();
    writeFileSync(entry, '// exact lazy second');
    const second = lazy.resolveArtifact!();
    expect(first.entrypointSha256).not.toBe(second.entrypointSha256);
    expect(second.entrypointSha256).toBe(
      createHash('sha256').update(readFileSync(entry)).digest('hex'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual CLI development argv runs one paired built Service with the selected isolated profile and complete answer', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-dev-argv-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  let requests = 0;
  const complete = 'development answer α\u0000tail';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { content: unknown }[] };
      expect(JSON.stringify(body.messages)).toContain('original development task');
      requests++;
      return new Response(
        `data: ${JSON.stringify({
          id: 'local',
          object: 'chat.completion.chunk',
          model: 'fixture',
          choices: [
            { index: 0, delta: { role: 'assistant', content: complete }, finish_reason: null },
          ],
        })}\n\ndata: ${JSON.stringify({
          id: 'local',
          object: 'chat.completion.chunk',
          model: 'fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'local',
        tools: [],
        models: [
          {
            id: 'local',
            provider: 'compatible',
            model: 'fixture',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const outdir = join(root, 'apps/service/dist');
    mkdirSync(outdir, { recursive: true });
    symlinkSync(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    const build = await Bun.build({
      entrypoints: [join(repositoryRoot, 'apps/service/src/main.ts')],
      target: 'bun',
      packages: 'external',
      outdir,
      naming: 'main.js',
    });
    expect(build.success).toBe(true);
    const driver = join(root, 'driver.ts');
    writeFileSync(
      driver,
      `import { runDevelopmentCLI } from ${JSON.stringify(join(repositoryRoot, 'scripts/development/unified-cli.ts'))};\ntry { process.exitCode = await runDevelopmentCLI({root:${JSON.stringify(root)}}); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n'); process.exitCode=1; }\n`,
    );
    const processChild = Bun.spawn(
      [
        process.execPath,
        driver,
        'run',
        '--task',
        'original development task',
        '--data-root',
        profile.dataRoot,
        '--workspace',
        workspace,
        '--full',
        '--trust-workspace',
      ],
      {
        cwd: workspace,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
      },
    );
    child = processChild;
    const [code, stdout, stderr] = await Promise.all([
      processChild.exited,
      new Response(processChild.stdout).text(),
      new Response(processChild.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(requests).toBe(1);
    const answer = stdout.split('\n').find((line) => line.startsWith('answer '));
    expect(answer).toBeDefined();
    expect(JSON.parse(answer!.slice(7))).toMatchObject({ complete: true, content: complete });
    expect(stdout).toContain('terminal');
    expect(stdout).toContain(
      "Paired host exit stops only this Service instance's remaining owned work",
    );
    expect(existsSync(join(root, '.kite-code', 'unified-development'))).toBe(false);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('daemon asset resolution is lazy and exact; read-only and compatible reuse need no target build', async () => {
  const root = realpathSync(
    mkdtempSync(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'kite-cli-dev-daemon-'),
    ),
  );
  let owner: Awaited<ReturnType<typeof reserveDaemonEndpoint>> | undefined,
    service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    for (const argv of [['server', 'status'], ['server', 'stop'], ['web']]) {
      const selection = selectDevelopmentCLI(argv, root, '/missing-executable');
      expect(selection.artifact).toBeUndefined();
      expect(selection.resolveArtifact).toBeUndefined();
    }
    const selection = selectDevelopmentCLI(['server', 'start'], root, '/missing-executable');
    expect(selection.artifact).toBeUndefined();
    expect(selection.resolveArtifact).toBeDefined();
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
    await expect(
      runDevelopmentCLI({ argv: ['server', 'status'], root, executable: '/missing-executable' }),
    ).resolves.toBe(0);
    await expect(
      runDevelopmentCLI({ argv: ['server', 'stop'], root, executable: '/missing-executable' }),
    ).resolves.toBe(0);
    await expect(
      runDevelopmentCLI({ argv: ['web'], root, executable: '/missing-executable' }),
    ).rejects.toMatchObject({ code: 'daemon_web_unavailable' });
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
    await expect(
      runDevelopmentCLI({ argv: ['server', 'start'], root, executable: '/missing-executable' }),
    ).rejects.toMatchObject({ code: 'development_service_asset_unavailable' });
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
    const p = selectProfile({ dataRoot: selection.dataRoot, profile: selection.profile }),
      profile = { dataRoot: p.dataRoot, name: p.profile, accessKey: p.profileAccessKey };
    const socket = join(root, 's.sock');
    owner = await reserveDaemonEndpoint(
      selectDaemonEndpoint({ profileAccessKey: p.profileAccessKey, explicitSocket: socket }),
      { profile, instanceId: 'existing', buildId: 'running-original', workspace: root },
    );
    service = await startService({
      profile,
      instanceId: 'existing',
      buildId: 'running-original',
      capabilities: ['sessions', 'history'],
    });
    await owner.listen({
      httpEndpoint: service.endpoint,
      token: service.bootstrap.token,
      webOrigin: service.endpoint,
    });
    expect(
      await runDevelopmentCLI({
        argv: ['server', 'start', '--server', socket],
        root,
        executable: '/missing-executable',
      }),
    ).toBe(0);
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
    await owner.close();
    owner = undefined;
    await service.close();
    service = undefined;
    const out = join(root, 'apps/service/dist'),
      web = join(root, 'apps/web/dist');
    mkdirSync(out, { recursive: true });
    mkdirSync(web, { recursive: true });
    writeFileSync(join(out, 'main.js'), '// paired exact');
    writeFileSync(join(out, 'daemon-main.js'), '// daemon original');
    writeFileSync(join(web, 'manifest.json'), '{}');
    const lazy = selectDevelopmentCLI(['server', 'restart'], root);
    const a = lazy.resolveArtifact!();
    expect(a.daemon).toMatchObject({
      entrypoint: join(out, 'daemon-main.js'),
      entrypointSha256: createHash('sha256')
        .update(readFileSync(join(out, 'daemon-main.js')))
        .digest('hex'),
      web: {
        directory: web,
        manifestSha256: createHash('sha256')
          .update(readFileSync(join(web, 'manifest.json')))
          .digest('hex'),
      },
    });
    expect(Object.isFrozen(a.daemon)).toBe(true);
    writeFileSync(join(web, 'manifest.json'), ' { } ');
    const b = lazy.resolveArtifact!();
    expect(b.buildId).not.toBe(a.buildId);
    expect(b.entrypointSha256).toBe(a.entrypointSha256);
    writeFileSync(join(out, 'daemon-main.js'), '// daemon replacement');
    expect(lazy.resolveArtifact!().buildId).not.toBe(b.buildId);
    rmSync(join(web, 'manifest.json'));
    symlinkSync(join(out, 'main.js'), join(web, 'manifest.json'));
    expect(() => lazy.resolveArtifact!()).toThrow('development_daemon_asset_unavailable');
  } finally {
    await owner?.close();
    await service?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('actual development wrapper new argv binds original Work, cold caller, Files point and recovery GET through exact local built Service', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-dev-callers-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'original.txt'), '原始完整字节😀\r\n');
  let requests = 0,
    seedStep = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      requests++;
      const user = body.messages.filter((m) => m.role === 'user').at(-1)!.content;
      let call: { name: string; input: unknown } | undefined;
      if (user === 'seed actual checkpoint') {
        if (seedStep === 0)
          call = { name: 'files.read', input: { path: 'original.txt', limit: 10000 } };
        if (seedStep === 1)
          call = {
            name: 'files.write',
            input: {
              path: 'original.txt',
              base: JSON.parse(body.messages.filter((m) => m.role === 'tool').at(-1)!.content)
                .baseline,
              content: 'actual modified\r\n',
            },
          };
        seedStep++;
      } else expect(user).toBe('完整 wrapper work 😀\r\n');
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `tool-${requests}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'real development complete' },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let seed: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let sharedOwner: Awaited<ReturnType<typeof reserveDaemonEndpoint>> | undefined;
  let running: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixture',
            baseURL: `${provider.url.href}v1`,
          },
        ],
        tools: [
          { id: 'files.read', definitionVersion: '3' },
          { id: 'files.write', definitionVersion: '2' },
        ],
      }),
      { mode: 0o600 },
    );
    const outdir = join(root, 'apps/service/dist');
    mkdirSync(outdir, { recursive: true });
    symlinkSync(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    const build = await Bun.build({
      entrypoints: [join(repositoryRoot, 'apps/service/src/main.ts')],
      target: 'bun',
      packages: 'external',
      outdir,
      naming: 'main.js',
    });
    expect(build.success).toBe(true);
    const selected = selectDevelopmentCLI(['files', 'checkpoints', 's'], root).resolveArtifact!();
    seed = await launchPairedService({
      ...selected,
      profile,
      instanceId: 'development-seed',
      requiredCapabilities: ['commands', 'sessions', 'file_recovery', 'session_recovery'],
    });
    const client = seed.client,
      storeId = seed.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'owned',
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
      commandId: 'full',
      mode: 'full',
      ifRevision: mode.revision,
      makeDefault: false,
      ifDefaultRevision: mode.defaultRevision,
    });
    await client.startRun('s', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'seed',
      content: 'seed actual checkpoint',
    });
    const deadline = Date.now() + 10000;
    for (;;) {
      const command = await client.getCommand('seed');
      if (command.status === 'applied') {
        const run = await client.getRun((command.receipt as { runId: string }).runId);
        if (!run.isActive) {
          expect(run.status).toBe('completed');
          break;
        }
      }
      if (Date.now() > deadline) throw Error('development_seed_deadline');
      await Bun.sleep(10);
    }
    expect(requests).toBe(3);
    const page = await client.listFileCheckpoints('s');
    expect(page.payload.items.length).toBeGreaterThan(0);
    const point = page.payload.items[0]!.checkpoint;
    const interrupt = {
      kind: 'session.recover' as const,
      expectedStoreId: storeId,
      commandId: 'original-interrupt',
      decision: 'interrupt' as const,
    };
    await client.recoverSession('s', interrupt);
    const access = acquireProfileAccess(profile);
    const journal = openRecoveryJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
    try {
      expect(journal.prepare({ kind: 'interrupt', sessionId: 's', request: interrupt })).toBe(true);
    } finally {
      journal.close();
      access.lock.release();
    }
    await seed.close();
    seed = undefined;
    const driver = join(root, 'driver.ts');
    writeFileSync(
      driver,
      `import { runDevelopmentCLI } from ${JSON.stringify(join(repositoryRoot, 'scripts/development/unified-cli.ts'))};\ntry { process.exitCode=await runDevelopmentCLI({root:${JSON.stringify(root)}}); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n'); process.exitCode=1; }\n`,
    );
    const argv = async (words: string[]) => {
      const processChild = Bun.spawn(
        [process.execPath, driver, ...words, '--data-root', profile.dataRoot],
        {
          cwd: workspace,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
        },
      );
      running = processChild;
      const [code, stdout, stderr] = await Promise.all([
        processChild.exited,
        new Response(processChild.stdout).text(),
        new Response(processChild.stderr).text(),
      ]);
      if (code !== 0)
        throw Error(`development argv ${words[0]} exit ${code}: ${stderr}\n${stdout}`);
      expect(stderr).toBe(
        ['work', 'caller'].includes(words[0]!)
          ? words.includes('--server')
            ? 'Shared client disconnected; daemon work remains owned by Service'
            : "Paired host exit stops only this Service instance's remaining owned work"
          : '',
      );
      return stdout;
    };
    const work = {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'wrapper-work',
      content: '完整 wrapper work 😀\r\n',
    };
    const workOutput = await argv(['work', 's', '--input', JSON.stringify(work)]);
    expect(workOutput).toContain('completed');
    expect(workOutput).toContain('wrapper-work');
    expect(requests).toBe(4);
    const saved = JSON.parse(
      readFileSync(join(profile.profilePath, 'ui/caller-intents.json'), 'utf8'),
    ) as { records: { intent: { request: { commandId: string } } }[] };
    const intent = saved.records.find((r) => r.intent.request.commandId === 'wrapper-work')!.intent;
    const lookup = await argv(['caller', 'lookup', 's', '--input', JSON.stringify(intent)]);
    expect(lookup).toContain('wrapper-work');
    expect(lookup).toContain(storeId);
    expect(
      await argv([
        'caller',
        'list',
        's',
        '--input',
        JSON.stringify({ expectedStoreId: storeId, workspaceId: 'w' }),
      ]),
    ).toContain('wrapper-work');
    const directory = JSON.parse((await argv(['files', 'checkpoints', 's'])).trim());
    expect(directory).toMatchObject({ storeId, sessionId: 's', workspaceId: 'w' });
    expect(
      directory.payload.items.some(
        (item: { checkpoint: { id: string } }) => item.checkpoint.id === point.id,
      ),
    ).toBe(true);
    const detail = JSON.parse((await argv(['files', 'detail', 's', point.id])).trim());
    expect(detail.boundary).toMatchObject({
      storeId,
      sessionId: 's',
      workspaceId: 'w',
      checkpoint: point,
    });
    expect(detail.preview).toMatchObject({
      storeId,
      sessionId: 's',
      workspaceId: 'w',
      payload: { checkpoint: point },
    });
    expect(
      detail.preview.payload.files.some((file: { path: string }) => file.path === 'original.txt'),
    ).toBe(true);
    const recovery = await argv([
      'recovery',
      'lookup',
      's',
      '--input',
      JSON.stringify({ expectedStoreId: storeId, commandId: interrupt.commandId }),
    ]);
    expect(recovery).toContain('interrupted');
    expect(recovery).toContain('original-interrupt');
    expect(requests).toBe(4);
    expect(readFileSync(join(workspace, 'original.txt'), 'utf8')).toBe('actual modified\r\n');
    expect(existsSync(join(root, 'apps/cli/host/cli-assets.json'))).toBe(false);
    expect(existsSync(join(root, '.kite-code'))).toBe(false);
    const finalArtifact = selectDevelopmentCLI(['files', 'intents', 's'], root).resolveArtifact!();
    expect(finalArtifact.entrypointSha256).toBe(selected.entrypointSha256);
    seed = await launchPairedService({
      ...finalArtifact,
      profile,
      instanceId: 'development-shared',
      requiredCapabilities: ['commands', 'sessions', 'file_recovery'],
    });
    const original = await seed.client.getCommand('wrapper-work');
    expect(original).toMatchObject({
      id: 'wrapper-work',
      originStoreId: storeId,
      sessionId: 's',
      status: 'applied',
    });
    expect((await seed.client.getRun((original.receipt as { runId: string }).runId)).status).toBe(
      'completed',
    );
    const socket = join(root, 'shared.sock');
    sharedOwner = await reserveDaemonEndpoint(
      selectDaemonEndpoint({ profileAccessKey: profile.profileAccessKey, explicitSocket: socket }),
      {
        profile: {
          dataRoot: profile.dataRoot,
          name: profile.profile,
          accessKey: profile.profileAccessKey,
        },
        instanceId: 'development-shared',
        buildId: finalArtifact.buildId,
        workspace,
      },
    );
    await sharedOwner.listen({
      httpEndpoint: seed.bootstrap.endpoint,
      token: seed.bootstrap.token,
      webOrigin: seed.bootstrap.endpoint,
    });
    expect(
      await argv(['caller', 'lookup', 's', '--input', JSON.stringify(intent), '--server', socket]),
    ).toContain('wrapper-work');
    const sharedPoints = JSON.parse(
      (await argv(['files', 'checkpoints', 's', '--server', socket])).trim(),
    );
    expect(sharedPoints).toEqual(directory);
    expect(requests).toBe(4);
    expect(await seed.client.getCommand('wrapper-work')).toEqual(original);
  } finally {
    if (running && running.exitCode === null) {
      running.kill('SIGTERM');
      await running.exited;
    }
    await sharedOwner?.close();
    await seed?.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
