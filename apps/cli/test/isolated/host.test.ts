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
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CLIServiceArtifact } from '../../host';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture(body: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-host-')));
  const workspace = join(root, 'workspace'),
    elsewhere = join(root, 'elsewhere');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(elsewhere, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'driver' });
  let calls = 0;
  const observed: string[][] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(request) {
      const input = (await request.json()) as { messages: { content: unknown }[] };
      calls++;
      observed.push(
        input.messages.map((item) =>
          typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
        ),
      );
      const text = calls === 1 ? body : 'second complete answer';
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < text.length; offset += 32768)
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: 'actual', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { content: text.slice(offset, offset + 32768) }, finish_reason: null }] })}\n\n`,
              ),
            );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id: 'actual', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'configured',
      tools: [],
      models: [
        {
          id: 'configured',
          provider: 'compatible',
          model: 'fixture',
          baseURL: `${provider.url.href}v1`,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const service = join(root, 'service.js');
  symlinkSync(join(import.meta.dir, '../../../../node_modules'), join(root, 'node_modules'), 'dir');
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../service/src/main.ts')],
    target: 'bun',
    packages: 'external',
    outdir: root,
    naming: 'service.js',
  });
  if (!result.success) throw new Error('fixture_build_failed');
  const artifact: CLIServiceArtifact = {
    entrypoint: service,
    entrypointSha256: hash(readFileSync(service)),
    executable: process.execPath,
    executableSha256: hash(readFileSync(process.execPath)),
    buildId: `cli-fixture-${hash(readFileSync(service))}`,
    apiMajor: 1,
  };
  const driver = join(root, 'driver.ts');
  writeFileSync(
    driver,
    `import { runCLIProcess } from ${JSON.stringify(join(import.meta.dir, '../../host/main.ts'))};\ntry { process.exitCode = await runCLIProcess({artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'driver',cwd:${JSON.stringify(workspace)}}); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n'); process.exitCode=1; }\n`,
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  async function run(argv: string[]) {
    const child = Bun.spawn([process.execPath, driver, ...argv], {
      cwd: elsewhere,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
    });
    children.push(child);
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  return {
    root,
    profile,
    artifact,
    run,
    calls: () => calls,
    observed,
    counts() {
      const db = new Database(profile.databasePath, { readonly: true });
      try {
        return {
          sessions: (db.query('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n,
          runs: (db.query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n,
          commands: (db.query('SELECT COUNT(*) AS n FROM command').get() as { n: number }).n,
        };
      } finally {
        db.close();
      }
    },
    close() {
      for (const child of children) if (child.exitCode === null) child.kill();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('actual argv CLI runs and resumes its exact persisted Session through built paired Service and prints the complete 17MiB verified answer', async () => {
  const body = `${'a'.repeat(17 * 1024 * 1024)}\u0000original α tail`;
  const f = await fixture(body);
  try {
    const first = await f.run([
      'run',
      '--task',
      'first',
      '--thread',
      'original',
      '--full',
      '--trust-workspace',
    ]);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    const lines = first.stdout.split('\n');
    const intent = JSON.parse(lines.find((line) => line.startsWith('work intent '))!.slice(12)) as {
      storeId: string;
      sessionId: string;
      commandId: string;
    };
    expect(intent.sessionId).toBe('original');
    expect(lines).toContain(`accepted ${intent.commandId}`);
    expect(lines).toContain(`terminal ${intent.commandId} succeeded`);
    const answer = JSON.parse(lines.find((line) => line.startsWith('answer '))!.slice(7)) as {
      complete: boolean;
      content: string;
      commandId: string;
      storeId: string;
      sessionId: string;
    };
    expect(answer.complete).toBe(true);
    expect(hash(answer.content)).toBe(hash(body));
    expect(answer.content.endsWith('\u0000original α tail')).toBe(true);
    expect(answer.commandId).toBe(intent.commandId);
    expect(answer.storeId).toBe(intent.storeId);
    expect(answer.sessionId).toBe('original');
    expect(f.calls()).toBe(1);
    expect(first.stdout.includes('Bearer')).toBe(false);
    const counts = f.counts();
    expect(counts).toMatchObject({ sessions: 1, runs: 1 });
    const status = await f.run(['run', '--execution-status']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      identity: { storeId: intent.storeId, profileAccessKey: f.profile.profileAccessKey },
      scope: { sessionId: null },
      execution: {
        state: 'available',
        sandbox: { backend: 'none', available: false },
        permissions: { workspaceTrust: 'trusted', scope: 'default' },
      },
    });
    expect(status.stderr).toContain('Paired host exit stops only this Service instance');
    expect(f.counts()).toEqual(counts);
    expect(f.calls()).toBe(1);
    const missing = await f.run(['resume', '--thread', 'missing', '--task', 'do not create']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('session_not_found\n');
    expect(f.counts()).toEqual(counts);
    expect(f.calls()).toBe(1);
    const resumed = await f.run(['resume', '--thread', 'original', '--task', 'again']);
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toBe('');
    const second = JSON.parse(
      resumed.stdout
        .split('\n')
        .find((line) => line.startsWith('answer '))!
        .slice(7),
    ) as { content: string; sessionId: string; commandId: string };
    expect(second.content).toBe('second complete answer');
    expect(second.sessionId).toBe('original');
    expect(second.commandId).not.toBe(intent.commandId);
    expect(f.calls()).toBe(2);
    expect(f.observed[1]!.some((text) => text.endsWith('\u0000original α tail'))).toBe(true);
    expect(f.counts().sessions).toBe(1);
    expect(f.counts().runs).toBe(2);
  } finally {
    f.close();
  }
}, 45000);

test('help, version, invalid arguments and readonly daemon status do not open a profile or start Provider work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-help-')));
  const dataRoot = join(root, 'absent');
  const driver = join(root, 'driver.ts');
  writeFileSync(
    driver,
    `import { runCLIProcess } from ${JSON.stringify(join(import.meta.dir, '../../host/main.ts'))};\ntry { process.exitCode=await runCLIProcess({dataRoot:${JSON.stringify(dataRoot)}}); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n');process.exitCode=1; }\n`,
  );
  try {
    for (const [argv, expected] of [
      [['--help'], 0],
      [['--version'], 0],
      [['run', '--feature', 'x'], 1],
      [['server', 'status'], ['darwin', 'linux'].includes(process.platform) ? 0 : 1],
    ] as const) {
      const child = Bun.spawn([process.execPath, driver, ...argv], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(expected);
      if (argv[0] === 'server' && expected === 0) {
        expect(JSON.parse(stdout)).toMatchObject({ state: 'absent', targetBuildId: null });
        expect(stderr).toBe('');
      }
      expect(`${stdout}${stderr}`).not.toContain('accepted ');
      expect(existsSync(dataRoot)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
