import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStdioPermissionReader, promptPermissionMode } from '../../src/permissions';
import { compileFileRecoveryTUI } from '../fixtures/file-recovery-profile';
import { recoveryProfile } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
test('80x24 actual composer edits graphemes and bracketed paste without premature POST or placeholder content', async () => {
  const f = await recoveryProfile();
  let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let relay: ReturnType<typeof Bun.serve> | undefined;
  let closing = false;
  const transcript = `${f.root}-composer.pty.log`;
  try {
    const preparation = await f.launch();
    try {
      await preparation.client.recoverSession('s', {
        kind: 'session.recover',
        expectedStoreId: f.storeId,
        commandId: 'composer-preparation',
        decision: 'interrupt',
      });
      await preparation.client.createSession({
        expectedStoreId: f.storeId,
        commandId: 'composer-session',
        sessionId: 'composer',
        workspaceId: 'w',
        title: 'Composer',
      });
      const reader = createStdioPermissionReader(Readable.from(['auto\n']));
      try {
        await promptPermissionMode('composer', f.storeId, reader, {
          client: preparation.client,
          write() {},
        });
      } finally {
        reader.dispose();
      }
    } finally {
      await preparation.close();
    }
    const configPath = join(f.profile.profilePath, 'config.jsonc'),
      config = JSON.parse(readFileSync(configPath, 'utf8')),
      originalURL = config.models[0].baseURL;
    let relayed = 0;
    relay = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const bytes = await request.arrayBuffer();
        relayed++;
        if (relayed === 1) {
          writeFileSync(join(f.root, 'composer-model-entered'), 'owned real SDK request');
          while (!existsSync(join(f.root, 'composer-model-release')) && !closing)
            await Bun.sleep(5);
        }
        if (closing) throw Error('owned fixture closed');
        const headers = new Headers(request.headers);
        for (const name of ['host', 'connection', 'content-length', 'transfer-encoding'])
          headers.delete(name);
        return fetch(originalURL + '/chat/completions', {
          method: 'POST',
          headers,
          body: bytes,
        });
      },
    });
    config.models[0].baseURL = relay.url.href + 'v1';
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const network = join(f.root, 'composer-network'),
      runner = join(f.root, 'composer-runner.ts');
    const paste = '真实第一行🙂e\u0301\r\n' + '完整中文尾部'.repeat(70) + '\nEND_ORIGINAL_PASTE';
    const expected = '首前中🙂改后' + paste;
    writeFileSync(
      runner,
      `import{appendFileSync}from'node:fs';import{runTUIHost}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{appendFileSync(${JSON.stringify(network)},JSON.stringify({method:args[1]?.method??'GET',path:new URL(String(args[0])).pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');return actual(...args);},{preconnect:actual.preconnect});await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'composer',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});`,
    );
    const built = await compileFileRecoveryTUI(f.root, runner);
    if (!built.success) throw new AggregateError(built.logs, 'composer_tui_compile_failed');
    driver = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        fileURLToPath(new URL('../fixtures/tui-composer-pty.ts', import.meta.url)),
        JSON.stringify({
          root: f.root,
          runner: join(f.root, 'composer-runner.js'),
          network,
          profilePath: f.profile.profilePath,
          paste,
          expected,
          transcript,
        }),
      ],
      { stdout: 'pipe', stderr: 'pipe', ...(process.platform === 'win32' ? { ipc() {} } : {}) },
    );
    const [out, err, code] = await Promise.all([
      new Response(driver.stdout).text(),
      new Response(driver.stderr).text(),
      driver.exited,
    ]);
    if (code !== 0) {
      console.error(err);
      console.error(
        'actual composer failure facts',
        JSON.stringify({
          commands: f.rows('SELECT id,kind,status,receipt_json FROM command'),
          runs: f.rows('SELECT id,origin_command_id,status,is_active,reason FROM run'),
          executions: f.rows('SELECT id,kind,state,run_id,result_json FROM execution'),
          calls: f.calls(),
        }),
      );
    }
    console.log('PTY transcript', transcript);
    expect(code).toBe(0);
    expect(out).toContain('COMPOSER_REAL_UTF8_ONCE');
    const rows = readFileSync(network, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const writes = rows.filter((row) => row.method === 'POST' && row.body?.kind === 'run.start');
    expect(
      rows.filter((row) => row.method === 'POST' && row.path.includes('/interactions/')),
    ).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({
      kind: 'run.start',
      expectedStoreId: f.storeId,
      content: expected,
    });
    expect(
      f.rows(
        "SELECT origin_command_id,status FROM run WHERE session_id IN ('s','composer') ORDER BY started_at",
      ),
    ).toEqual([
      { origin_command_id: 'work', status: 'interrupted' },
      { origin_command_id: writes[0].body.commandId, status: 'completed' },
    ]);
    expect(
      f.rows(
        "SELECT json_extract(p.json,'$.content') AS content FROM message m JOIN message_part p ON p.message_id=m.id WHERE m.session_id='composer' AND m.role='user' AND p.kind='text' AND p.ordinal=0",
      ),
    ).toEqual([{ content: expected }]);
    const drafts = JSON.parse(readFileSync(join(f.profile.profilePath, 'ui/tui.json'), 'utf8'));
    expect(
      drafts.drafts
        .filter((row: { text: string }) => row.text)
        .map((row: { storeId: string; workspaceId: string; sessionId: string; text: string }) => ({
          storeId: row.storeId,
          workspaceId: row.workspaceId,
          sessionId: row.sessionId,
          text: row.text,
        }))
        .sort((a: { sessionId: string }, b: { sessionId: string }) =>
          a.sessionId.localeCompare(b.sessionId),
        ),
    ).toEqual([
      { storeId: f.storeId, workspaceId: 'w', sessionId: 'composer', text: 'COMPOSER_SCOPE_TEXT' },
      { storeId: f.storeId, workspaceId: 'w', sessionId: 's', text: 'ORIGINAL_SCOPE_TEXT' },
    ]);
    expect(f.calls()).toBe(3);
    expect(f.reviews).toHaveLength(2);
    expect(f.reviews.map((review) => review.body.tools ?? [])).toEqual([[], []]);
    expect(
      f.reviewProof().map(({ state, outcome, decision }) => ({ state, outcome, decision })),
    ).toEqual(Array(2).fill({ state: 'succeeded', outcome: 'succeeded', decision: 'ask_user' }));
  } finally {
    if (driver && driver.exitCode === null) {
      if (process.platform === 'win32') driver.send('composer-driver-stop');
      else driver.kill('SIGINT');
      await driver.exited;
    }
    closing = true;
    relay?.stop(true);
    f.close();
  }
}, 30000);
