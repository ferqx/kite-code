import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { launchPairedService } from '@kite-ai/service/paired';

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
function stamp(path: string) {
  const value = statSync(path, { bigint: true });
  return {
    size: value.size.toString(),
    inode: value.ino.toString(),
    mtime: value.mtimeNs.toString(),
    hash: hash(readFileSync(path)),
  };
}
type ProviderBody = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string; parameters: unknown } }[];
};

async function qualify(scenario: 'normal' | 'drift' | 'kill') {
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
      const user = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
      const key = user.includes('LATER_ACTUAL_RUN')
          ? 'late'
          : user.includes('SECOND_ACTUAL_RUN')
            ? 'second'
            : 'first',
        step = steps.get(key) ?? 0;
      steps.set(key, step + 1);
      let call: { name: string; input: Json } | null = null;
      if (step === 0) call = { name: 'files.read', input: { path: 'original.txt', limit: 10000 } };
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
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
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
    const helper = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../electron/profile-access-helper.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'helper.js',
    });
    const driver = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../native-file-recovery-node.fixture.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'driver.js',
    });
    expect(helper.success).toBe(true);
    expect(driver.success).toBe(true);
    const bun = realpathSync(process.execPath),
      helperPath = join(root, 'helper.js'),
      inputPath = join(root, 'native-input.json');
    writeFileSync(
      inputPath,
      JSON.stringify({
        drift: scenario === 'drift',
        bootstrap: child.bootstrap,
        pointId: point.id,
        path: originalPath,
        preimage,
        access: {
          profile: { dataRoot: profile.dataRoot, profile: profile.profile },
          bunExecutable: bun,
          bunSha256: hash(readFileSync(bun)),
          helperPath,
          helperSha256: hash(readFileSync(helperPath)),
        },
      }),
      { mode: 0o600 },
    );
    if (scenario === 'kill') {
      const raw = JSON.parse(readFileSync(inputPath, 'utf8')),
        barrier = join(root, 'before-post.json');
      writeFileSync(inputPath, JSON.stringify({ ...raw, killWindow: 'before_post', barrier }), {
        mode: 0o600,
      });
      const native = Bun.spawn(
        [realpathSync(Bun.which('node')!), join(root, 'driver.js'), inputPath],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { HOME: ownedHome, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        },
      );
      const stderr = new Response(native.stderr).text();
      try {
        await until(
          async () => existsSync(barrier),
          (value) => value,
        );
        native.kill('SIGKILL');
        await native.exited;
        expect(() => process.kill(native.pid, 0)).toThrow();
      } finally {
        native.kill('SIGKILL');
        await native.exited;
      }
      if (native.exitCode !== 137 && native.exitCode !== -9) console.error(await stderr);
      writeFileSync(inputPath, JSON.stringify({ ...raw, killWindow: 'cold_lookup', barrier }), {
        mode: 0o600,
      });
      const cold = Bun.spawn(
          [realpathSync(Bun.which('node')!), join(root, 'driver.js'), inputPath],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { HOME: ownedHome, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          },
        ),
        out = new Response(cold.stdout).text(),
        err = new Response(cold.stderr).text(),
        timer = setTimeout(() => cold.kill('SIGKILL'), 15000);
      try {
        const code = await cold.exited;
        if (code) console.error(await err);
        expect(code).toBe(0);
        expect(await out).toContain('native-file-recovery-killed-before-post-qualified');
      } finally {
        clearTimeout(timer);
        cold.kill('SIGKILL');
        await cold.exited;
      }
    } else {
      const native = Bun.spawn(
          [realpathSync(Bun.which('node')!), join(root, 'driver.js'), inputPath],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { HOME: ownedHome, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          },
        ),
        out = new Response(native.stdout).text(),
        err = new Response(native.stderr).text(),
        timer = setTimeout(() => native.kill('SIGKILL'), 15000);
      try {
        const code = await native.exited,
          stderr = await err;
        if (code) console.error(stderr);
        expect(code).toBe(0);
        console.info((await out).trim());
        expect(await out).toContain('native-file-recovery-node-qualified');
      } finally {
        clearTimeout(timer);
        native.kill('SIGKILL');
        await native.exited;
      }
    }
    expect(requests).toHaveLength(scenario === 'drift' ? 12 : 8);
    expect(readFileSync(originalPath)).toEqual(
      scenario === 'normal'
        ? original
        : Buffer.from(
            scenario === 'drift'
              ? 'late actual modified UTF8\r\n'
              : 'second actual modified UTF8\r\n',
          ),
    );
    const after = await reader.getMetadata();
    const state = stamp(originalPath);
    for (let n = 0; n < 3; n++) await client.listFileCheckpoints('s');
    expect((await reader.getMetadata()).lastChangeCursor).toBe(after.lastChangeCursor);
    expect(stamp(originalPath)).toEqual(state);
    expect(requests).toHaveLength(scenario === 'drift' ? 12 : 8);
  } finally {
    await reader?.close();
    if (child) await child.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}
test(
  'actual default paired + source-tree-external Node DB4 three-scope recovery keeps original lost-reply IDs, independent Ask and cold zero POST',
  () => qualify('normal'),
  30000,
);
test(
  'actual default paired Native both continue requires fresh all-unchanged point after external edit and a later completed Files Run',
  () => qualify('drift'),
  30000,
);
test(
  'actual Node Main SIGKILL after full two-leg durable submitting but before first POST keeps original IDs and cold GET only',
  () => qualify('kill'),
  30000,
);
