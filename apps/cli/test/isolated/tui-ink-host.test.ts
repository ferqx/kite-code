import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { compileFileRecoveryTUI } from '../fixtures/file-recovery-profile';
import { ptyDeadline } from '../fixtures/tui-pty';

const repo = resolve(import.meta.dir, '../../../..');
test('ordinary Ink TUI opens the untrusted gate, renders original Markdown and menus, completes one real Run and exits its owned Service', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-ink-parity-'))),
    workspace = join(root, 'workspace'),
    home = join(root, 'home');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(workspace);
  mkdirSync(home);
  const userConfiguration = ownedUserConfiguration(home);
  privateDirectory(join(profile.profilePath, 'ui'));
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  const original =
    '**literal user**\n\n`original inline`\n\n```ts\nconsole.log("user literal");\n```';
  const alignmentParagraph =
    'ALIGN_BEGIN 如果是明确的实施类任务，我会直接交付实现、必要验证和受影响文档的同步说明，不额外建计划；只有会实质改变产品行为、范围或授权边界且现有证据无法裁决的问题，我才会请你决定。 ALIGN_END';
  const response = `**Original assistant heading**\n\n| Column | Value |\n| --- | --- |\n| Original table cell | Exact value |\n\n\`\`\`ts\nconsole.log("original assistant");\n\`\`\`\n\n${alignmentParagraph}\n\nEND_ORIGINAL_ASSISTANT_COMPLETE`;
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      const frame = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'original', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${frame({ reasoning_content: 'Original private thinking' }, null)}${frame({ content: response }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  const transcript = `${root}.pty.log`,
    servicePid = join(root, 'owned-service.pid');
  try {
    writeFileSync(
      userConfiguration.path,
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
      }),
      { mode: 0o600 },
    );
    await buildOwnedDaemon(join(root, 'artifact'));
    const entrypoint = join(root, 'artifact/node_modules/@kite-ai/service/main.js'),
      executable = realpathSync(process.execPath);
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const artifact = {
      entrypoint,
      entrypointSha256: hash(entrypoint),
      executable,
      executableSha256: hash(executable),
      apiMajor: 1,
      buildId: 'ink-parity-owned',
    };
    const runner = join(root, 'ordinary-runner.ts');
    writeFileSync(
      runner,
      `import{writeFileSync}from'node:fs';import{runTUIProcess}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui-main.ts')).href)};process.exitCode=await runTUIProcess({argv:['--workspace',${JSON.stringify(workspace)}],artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'owned',cwd:${JSON.stringify(workspace)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(servicePid)},String(pid))});`,
    );
    const built = await compileFileRecoveryTUI(root, runner);
    if (!built.success) throw new AggregateError(built.logs, 'ordinary_tui_compile_failed');
    driver = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        fileURLToPath(new URL('../fixtures/tui-ink-parity-driver.ts', import.meta.url)),
        JSON.stringify({
          root,
          runner: join(root, 'ordinary-runner.js'),
          transcript,
          servicePid,
          original,
          alignmentParagraph,
          responseMarker: 'END_ORIGINAL_ASSISTANT_COMPLETE',
          databasePath: profile.databasePath,
        }),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          ...userConfiguration.homeEnvironment,
        },
        ...(process.platform === 'win32' ? { ipc() {} } : {}),
      },
    );
    const [stdout, stderr, code] = await ptyDeadline(
      Promise.all([
        new Response(driver.stdout).text(),
        new Response(driver.stderr).text(),
        driver.exited,
      ]),
      60000,
      'ordinary_ink_parity_driver_timeout',
    );
    if (code !== 0) console.error(stderr, '\nPTY transcript', transcript);
    expect(code).toBe(0);
    expect(stdout).toContain('ORDINARY_INK_PARITY_RUN_EXIT');
    expect(requests).toHaveLength(1);
    expect(
      requests[0]!.messages.some(
        (message) => message.role === 'user' && message.content === original,
      ),
    ).toBe(true);
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      expect(db.query('SELECT status,is_active FROM run').all()).toEqual([
        { status: 'completed', is_active: 0 },
      ]);
      const messages = db
        .query(
          "SELECT m.role,p.json FROM message m JOIN message_part p ON p.message_id=m.id WHERE p.kind='text' ORDER BY m.seq,p.ordinal",
        )
        .all() as { role: string; json: string }[];
      expect(
        messages.filter((row) => row.role === 'user').map((row) => JSON.parse(row.json).content),
      ).toEqual([original]);
      expect(
        messages
          .filter((row) => row.role === 'assistant')
          .map((row) => JSON.parse(row.json).content),
      ).toEqual([response]);
    } finally {
      db.close();
    }
  } finally {
    if (driver && driver.exitCode === null) {
      if (process.platform === 'win32') driver.send('owned-ink-parity-stop');
      else driver.kill('SIGTERM');
      await ptyDeadline(driver.exited, 10000, 'ordinary_driver_cleanup_timeout');
    }
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
