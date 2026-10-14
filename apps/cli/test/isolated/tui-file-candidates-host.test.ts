import { expect, test } from 'bun:test';
import { cpSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileToken, TuiController, type TuiPort } from '@kite-ai/ui/tui';
import { createTuiFileCandidates } from '../../host/file-candidates';
import { recoveryProfile } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
test('actual SDK original Workspace names exhaust >500, scoped ignore negation, unsafe subtrees, and 80x24 quoted Tab without mutation', async () => {
  const f = await recoveryProfile();
  let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  const transcript = join(tmpdir(), `kite-file-candidates-${crypto.randomUUID()}.pty.log`),
    wire = `${f.root}-file-wire.jsonl`;
  try {
    mkdirSync(join(f.workspace, '目录'), { recursive: true });
    writeFileSync(join(f.workspace, '目录', '中文 空格.txt'), 'CANDIDATE_BODY_MUST_NOT_BE_READ');
    const quoteName = process.platform === 'win32' ? 'quote 空格.txt' : 'quote"\\.txt';
    writeFileSync(join(f.workspace, '目录', quoteName), 'PRIVATE_TARGET_BODY');
    for (let i = 0; i < 605; i++)
      writeFileSync(join(f.workspace, `catalog-${String(i).padStart(4, '0')}.txt`), 'NEVER_READ');
    mkdirSync(join(f.workspace, 'nested'));
    writeFileSync(
      join(f.workspace, 'nested', '.gitignore'),
      '*.log\n!keep.log\n# nested comment\n',
    );
    writeFileSync(join(f.workspace, 'nested', 'drop.log'), 'hidden');
    writeFileSync(join(f.workspace, 'nested', 'keep.log'), 'visible');
    writeFileSync(join(f.workspace, '.gitignore'), '# comment\n*.tmp\n!keep.tmp\n\\#literal\n');
    writeFileSync(join(f.workspace, 'drop.tmp'), 'hidden');
    writeFileSync(join(f.workspace, 'keep.tmp'), 'visible');
    writeFileSync(join(f.workspace, '#literal'), 'hidden');
    mkdirSync(join(f.workspace, 'bad'));
    writeFileSync(join(f.workspace, 'bad', '.gitignore'), Buffer.from([0xff]));
    writeFileSync(join(f.workspace, 'bad', 'never.txt'), 'hidden bad subtree');
    mkdirSync(join(f.workspace, 'hard'));
    writeFileSync(join(f.root, 'hard-ignore'), 'nothing');
    linkSync(join(f.root, 'hard-ignore'), join(f.workspace, 'hard', '.gitignore'));
    writeFileSync(join(f.workspace, 'hard', 'never.txt'), 'hidden hardlink subtree');
    mkdirSync(join(f.root, 'outside'));
    writeFileSync(join(f.root, 'outside', 'OUTSIDE_SECRET.txt'), 'OUTSIDE_PRIVATE_BODY');
    symlinkSync(
      join(f.root, 'outside'),
      join(f.workspace, 'unsafe'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const shared = await f.launch();
    try {
      await shared.client.recoverSession('s', {
        kind: 'session.recover',
        expectedStoreId: f.storeId,
        commandId: 'files-preparation',
        decision: 'interrupt',
      });
      await shared.client.createSession({
        expectedStoreId: f.storeId,
        commandId: 'files-session',
        sessionId: 'files',
        workspaceId: 'w',
        title: 'Files',
      });
      mkdirSync(join(f.root, 'workspace-b'));
      writeFileSync(join(f.root, 'workspace-b', 'B_ONLY.txt'), 'never read');
      await shared.client.createWorkspace({
        expectedStoreId: f.storeId,
        id: 'wb',
        name: 'B',
        rootUri: pathToFileURL(join(f.root, 'workspace-b')).href,
      });
      await shared.client.createSession({
        expectedStoreId: f.storeId,
        commandId: 'files-session-b',
        sessionId: 'b',
        workspaceId: 'wb',
        title: 'B',
      });
      const port = createTuiFileCandidates(shared.client, f.storeId),
        scope = { storeId: f.storeId, sessionId: 'files', workspaceId: 'w' },
        signal = new AbortController();
      const paths: string[] = [];
      let cursor: string | undefined;
      let unavailable: readonly { path: string; reason: string }[] = [];
      do {
        const page = await port.read(
          scope,
          { query: '', ...(cursor ? { cursor } : {}) },
          signal.signal,
        );
        paths.push(...page.paths);
        unavailable = page.unavailable;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(paths.filter((p) => p.startsWith('catalog-'))).toHaveLength(605);
      expect(paths).toContain('目录/中文 空格.txt');
      expect(paths).toContain('nested/keep.log');
      expect(paths).toContain('keep.tmp');
      expect(paths).not.toContain('nested/drop.log');
      expect(paths).not.toContain('drop.tmp');
      expect(paths).not.toContain('#literal');
      expect(
        paths.some(
          (p) => p.includes('OUTSIDE_SECRET') || p.startsWith('bad/') || p.startsWith('hard/'),
        ),
      ).toBe(false);
      expect(unavailable.map((p) => p.path).sort()).toEqual(['bad', 'hard', 'unsafe']);
      await expect(
        port.read({ ...scope, workspaceId: 'wb' }, { query: '' }, signal.signal),
      ).rejects.toThrow('file_candidate_scope_mismatch');
      const b = await port.read(
        { storeId: f.storeId, sessionId: 'b', workspaceId: 'wb' },
        { query: '' },
        signal.signal,
      );
      expect(b.paths).toEqual(['B_ONLY.txt']);
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(port.read(scope, { query: '' }, cancelled.signal)).rejects.toThrow();
      // Delay an actual scoped page, not a fabricated response, across an actual Workspace switch.
      let release!: () => void, entered!: () => void;
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let first = true;
      const noMutation = async () => {
        throw Error('reader must not mutate');
      };
      const uiPort: TuiPort = {
        storeId: f.storeId,
        nextCommandId: () => 'unused',
        listSessions: async () => [],
        readSession: async (id, signal) => {
          const view = await shared.client.getView(id, { signal });
          return { storeId: view.storeId, view, messages: view.messages, interactions: [] };
        },
        submit: noMutation,
        answer: noMutation,
        cancel: noMutation,
        getCommand: noMutation,
        fileCandidates: {
          read: async (scope, input, signal) => {
            const page = await port.read(scope, input, signal);
            if (first) {
              first = false;
              entered();
              await delayed;
            }
            return page;
          },
        },
      };
      const controller = new TuiController(uiPort);
      await controller.select('files');
      controller.setDraft('@目录');
      const original = controller.readFileCandidates(fileToken('@目录', 3));
      await ready;
      await controller.select('b');
      controller.setDraft('@B');
      release();
      await original;
      expect(controller.state.fileCandidates).toBeUndefined();
      expect(controller.state.draft).toBe('@B');
      await controller.readFileCandidates(fileToken('@B', 2));
      expect(controller.state.fileCandidates?.paths).toEqual(['B_ONLY.txt']);
      controller.dispose();
      // Resolve the declared exact dependency in a standalone built host module, with only its admitted installed asset.
      const standalone = join(f.root, 'standalone');
      mkdirSync(standalone);
      const built = await Bun.build({
        entrypoints: [join(repo, 'apps/cli/host/file-candidates.ts')],
        outdir: standalone,
        target: 'bun',
        packages: 'external',
      });
      expect(built.success).toBe(true);
      const require = createRequire(join(repo, 'apps/cli/host/file-candidates.ts'));
      const ignoreRoot = resolve(require.resolve('ignore'), '..');
      expect(JSON.parse(readFileSync(join(ignoreRoot, 'package.json'), 'utf8')).version).toBe(
        '5.3.2',
      );
      cpSync(ignoreRoot, join(standalone, 'node_modules/ignore'), { recursive: true });
      const compiled = await import(pathToFileURL(join(standalone, 'file-candidates.js')).href);
      const standalonePage = await compiled
        .createTuiFileCandidates(shared.client, f.storeId)
        .read(scope, { query: '中文' }, signal.signal);
      expect(standalonePage.paths).toEqual(['目录/中文 空格.txt']);
      writeFileSync(
        `${f.root}-file-catalog-facts.json`,
        JSON.stringify({ scope, paths, unavailable, b }),
      );
    } finally {
      await shared.close();
    }
    const runner = join(f.root, 'file-runner.ts');
    writeFileSync(
      runner,
      `import{appendFileSync,writeFileSync}from'node:fs';import{runTUIHost}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{appendFileSync(${JSON.stringify(wire)},JSON.stringify({method:args[1]?.method??'GET',path:new URL(String(args[0])).pathname})+'\\n');return actual(...args);},{preconnect:actual.preconnect});await runTUIHost({testDiagnostics:true,dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'files',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(join(f.root, 'file-service.pid'))},String(pid),{mode:0o600})});`,
    );
    driver = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        join(repo, 'apps/cli/test/fixtures/tui-file-candidates-driver.ts'),
        runner,
        f.workspace,
        f.profile.profilePath,
        wire,
        transcript,
        quoteName,
        join(f.root, 'file-service.pid'),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        ...(process.platform === 'win32' ? { ipc() {} } : {}),
        env: { ...process.env, HOME: f.root, USERPROFILE: f.root },
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(driver.stdout).text(),
      new Response(driver.stderr).text(),
      driver.exited,
    ]);
    console.log('file candidate PTY', transcript);
    if (code !== 0) console.error(err);
    expect(code).toBe(0);
    expect(out).toContain('FILES_REAL_SCOPED_TAB_ZERO_POST');
    const rows = readFileSync(wire, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.method === 'POST')).toEqual([]);
    expect(f.rows("SELECT count(*) AS n FROM run WHERE session_id='files'")).toEqual([{ n: 0 }]);
    expect(f.calls()).toBe(1);
    writeFileSync(
      `${f.root}-file-post-facts.json`,
      JSON.stringify({
        wire: rows,
        commands: f.rows('SELECT id,kind,status,session_id,receipt_json FROM command'),
        runs: f.rows('SELECT id,session_id,origin_command_id,status FROM run'),
        providerCalls: f.calls(),
      }),
    );
  } finally {
    if (driver && driver.exitCode === null) {
      if (process.platform === 'win32') driver.send('owned-file-candidates-driver-stop');
      else driver.kill('SIGINT');
      await driver.exited;
    }
    f.close();
  }
}, 30000);
