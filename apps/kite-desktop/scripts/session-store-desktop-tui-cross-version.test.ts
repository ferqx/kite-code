import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { observeLegacyKiteStoreProcesses } from '../../../packages/kite-local-runtime/src/service/legacy-store-processes';
import { initializeKiteHomeStoreSchema } from '../../../packages/runtime-storage-sqlite/src/kite-home-store';
import { installOssCandidate } from '../../../scripts/release/install-oss-candidate';
import { createMockModelServer } from '../../../tests/tui-system/harness/fixtures';
import { submitUserMessage } from '../../../tests/tui-system/harness/input-helpers';
import {
  type PtyProcess,
  spawnReadyTui,
  waitForTuiReady,
} from '../../../tests/tui-system/harness/pty-process';
import { waitForText } from '../../../tests/tui-system/harness/terminal-screen';
import { createTestWorkspace } from '../../../tests/tui-system/harness/test-workspace';

/**
 * Native C09 qualification, run only in the coordinated macOS window:
 * KITE_C09_OLD_ARCHIVE=/private/tmp/kite-c08-old-candidate.tar.gz
 * KITE_C09_CURRENT_ARCHIVE=dist/oss-candidate/kite-code-macos-arm64.tar.gz
 * KITE_C09_PACKAGED_DESKTOP=apps/kite-desktop/out/kite-darwin-arm64/kite.app/Contents/MacOS/kite
 * bun test --parallel=1 apps/kite-desktop/scripts/session-store-desktop-tui-cross-version.test.ts
 *
 * The old installed TUI keeps its already-spawned old Service after its private
 * managed prefix selects the current release. The current packaged Desktop
 * shares only this test's private HOME. No user profile or install root is used.
 */
const oldArchive = process.env.KITE_C09_OLD_ARCHIVE;
const currentArchive = process.env.KITE_C09_CURRENT_ARCHIVE;
const packagedExecutable = process.env.KITE_C09_PACKAGED_DESKTOP;
const qualified =
  process.platform === 'darwin' && !!oldArchive && !!currentArchive && !!packagedExecutable;

type InspectorResult = { result?: { value?: unknown }; exceptionDetails?: unknown };

async function launchDesktop(
  application: string,
  home: string,
): Promise<{
  page: Page;
  close(): Promise<void>;
}> {
  const child = spawn(
    join(application, 'Contents/MacOS/kite'),
    ['--inspect-brk=0', '--remote-debugging-port=0'],
    {
      cwd: home,
      // Keep this native test's distribution search independent of the host
      // developer's PATH. The private managed prefix is invoked by exact path.
      env: {
        HOME: home,
        USERPROFILE: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: '/private/tmp',
        LANG: 'en_US.UTF-8',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<number | null>((done) => child.once('exit', done));
  let logs = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-16_384);
    });
  const endpoint = async (pattern: RegExp): Promise<string> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const match = logs.match(pattern);
      if (match?.[1]) return match[1];
      if (child.exitCode !== null) throw new Error(`Desktop exited before inspector: ${logs}`);
      await Bun.sleep(25);
    }
    throw new Error(`Desktop inspector timed out: ${logs}`);
  };
  let inspector: WebSocket | undefined;
  let browser: Browser | undefined;
  try {
    inspector = new WebSocket(await endpoint(/Debugger listening on (ws:\/\/[^\s]+)/u));
    await new Promise<void>((done, fail) => {
      inspector!.addEventListener('open', () => done(), { once: true });
      inspector!.addEventListener('error', () => fail(new Error('Inspector failed.')), {
        once: true,
      });
    });
    let nextId = 0;
    const pending = new Map<
      number,
      { done: (result: InspectorResult) => void; fail: (error: Error) => void }
    >();
    let onPause: (callFrameId: string) => void = () => {};
    inspector.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Debugger.paused') onPause(message.params.callFrames[0].callFrameId);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
        else waiter.done(message.result);
      }
    });
    const command = (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<InspectorResult> => {
      const id = ++nextId;
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`Inspector timed out: ${method}`));
        }, 30_000);
        pending.set(id, {
          done: (value) => {
            clearTimeout(timer);
            done(value);
          },
          fail: (error) => {
            clearTimeout(timer);
            fail(error);
          },
        });
        inspector!.send(JSON.stringify({ id, method, params }));
      });
    };
    await command('Runtime.enable');
    await command('Debugger.enable');
    const paused = new Promise<string>((done) => {
      onPause = done;
    });
    await command('Runtime.runIfWaitingForDebugger');
    const callFrameId = await paused;
    const isolated = await command('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression: `globalThis.__kiteC09 = require('electron');
__kiteC09.app.setPath('home', ${JSON.stringify(home)});
__kiteC09.app.setPath('appData', ${JSON.stringify(join(home, 'app-data'))});
__kiteC09.app.setPath('userData', ${JSON.stringify(join(home, 'app-data/dev.kite-code.desktop'))});
__kiteC09.app.getPath('home')`,
      returnByValue: true,
    });
    expect(isolated.result?.value).toBe(home);
    await command('Debugger.resume');
    browser = await chromium.connectOverCDP(
      await endpoint(/DevTools listening on (ws:\/\/[^\s]+)/u),
    );
    const page =
      browser.contexts()[0]!.pages()[0] ?? (await browser.contexts()[0]!.waitForEvent('page'));
    const evaluateMain = async (expression: string): Promise<unknown> => {
      const result = await command('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    await evaluateMain(
      `__kiteC09.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })`,
    );
    expect(await evaluateMain('__kiteC09.app.isPackaged')).toBe(true);
    return {
      page,
      close: async () => {
        await evaluateMain('__kiteC09.app.quit()').catch(() => undefined);
        inspector?.close();
        await browser?.close();
        const code = await Promise.race([exited, Bun.sleep(25_000).then(() => null)]);
        if (code === null && child.exitCode === null) child.kill('SIGKILL');
        expect(code).toBe(0);
      },
    };
  } catch (error) {
    inspector?.close();
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    throw new Error(`Native Desktop launch failed: ${String(error)}\n${logs}`);
  }
}

function captureHistory(path: string): {
  sessions: string[];
  runs: string[];
  events: string[];
} {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    return {
      sessions: db
        .query<{ session_id: string }, []>(
          'SELECT session_id FROM runtime_sessions ORDER BY session_id',
        )
        .all()
        .map((row) => row.session_id),
      runs: db
        .query<{ run_id: string }, []>('SELECT run_id FROM runtime_runs ORDER BY run_id')
        .all()
        .map((row) => row.run_id),
      events: db
        .query<{ event_json: string }, []>(
          'SELECT event_json FROM runtime_events ORDER BY session_id, sequence',
        )
        .all()
        .map((row) => row.event_json),
    };
  } finally {
    db.close(false);
  }
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test.skipIf(!qualified)(
  'packaged Desktop waits for an old TUI writer, then prepares and opens its history without restart',
  async () => {
    const workspace = createTestWorkspace({
      configOverrides: { interactionMode: 'auto', sandbox: { enabled: false } },
    });
    const model = createMockModelServer();
    model.setResponses([
      { message: { content: 'Old TUI remained writable while Desktop waited.' } },
    ]);
    const home = realpathSync.native(workspace.home);
    const config = join(home, '.kite-code');
    const canonical = join(config, 'kite-session.sqlite');
    const historical = join(config, 'kite.sqlite');
    const managed = join(home, 'managed');
    const application = join(home, 'kite.app');
    let oldTui: PtyProcess | undefined;
    try {
      expect(existsSync(oldArchive!)).toBe(true);
      expect(existsSync(currentArchive!)).toBe(true);
      expect(statSync(packagedExecutable!).isFile()).toBe(true);
      mkdirSync(join(home, 'app-data'), { mode: 0o700 });
      cpSync(resolve(dirname(packagedExecutable!), '../..'), application, {
        recursive: true,
        verbatimSymlinks: true,
      });
      await installOssCandidate({ archivePath: resolve(oldArchive!), prefix: managed });
      oldTui = await spawnReadyTui({
        executablePath: join(managed, 'bin/kite-tui'),
        workspace,
        mockServer: model,
      });
      expect(oldTui.exited).toBe(false);
      expect(existsSync(canonical)).toBe(true);

      // A separate known Store 9 source forces the current Desktop to enter
      // maintenance admission while the old TUI's old Service is alive.
      const legacy = new Database(historical, { create: true, strict: true });
      try {
        initializeKiteHomeStoreSchema(legacy);
        legacy.run('PRAGMA journal_mode=DELETE');
      } finally {
        legacy.close(false);
      }
      chmodSync(historical, 0o600);
      await installOssCandidate({ archivePath: resolve(currentArchive!), prefix: managed });
      const active = readFileSync(join(managed, 'active'), 'utf8').trim();
      expect(active).toMatch(/^[a-f0-9]{24}$/u);
      expect(fileHash(join(managed, 'releases', active, 'bin/kite-service'))).toBe(
        fileHash(join(application, 'Contents/Resources/service/kite-service')),
      );
      const oldWriter = observeLegacyKiteStoreProcesses();
      expect(oldWriter.status).toBe('busy');
      const oldServices =
        oldWriter.status === 'busy'
          ? oldWriter.matches.filter((entry) => entry.kind === 'service')
          : [];
      if (oldWriter.status === 'busy') expect(oldServices.length).toBeGreaterThan(0);
      const beforeWaiting = [fileHash(canonical), fileHash(historical)];
      const desktop = await launchDesktop(application, home);
      try {
        await desktop.page
          .getByText(/正在自动重试/u)
          .first()
          .waitFor({ timeout: 45_000 });
        expect([fileHash(canonical), fileHash(historical)]).toEqual(beforeWaiting);
        expect(oldTui.exited).toBe(false);

        // The old process performs a real persisted turn while this same Desktop is waiting.
        await submitUserMessage(oldTui, model, 'Old TUI writes while Desktop waits.', {
          timeout: 30_000,
        });
        await waitForText(
          () => oldTui!.viewport(),
          'Old TUI remained writable while Desktop waited.',
          30_000,
        );
        await waitForTuiReady(oldTui, 'main', workspace);
        const oldHistory = captureHistory(canonical);
        expect(oldHistory.sessions).toHaveLength(1);
        expect(oldHistory.runs.length).toBeGreaterThan(0);
        expect(
          oldHistory.events.some((event) => event.includes('Old TUI writes while Desktop waits.')),
        ).toBe(true);
        await oldTui.killAndWait();
        oldTui = undefined;
        const retiredDeadline = Date.now() + 10_000;
        while (Date.now() < retiredDeadline) {
          const observed = observeLegacyKiteStoreProcesses();
          if (
            observed.status === 'busy' &&
            oldServices.every(
              (old) =>
                !observed.matches.some(
                  (current) =>
                    current.pid === old.pid && current.startIdentity === old.startIdentity,
                ),
            )
          )
            break;
          await Bun.sleep(50);
        }
        const observed = observeLegacyKiteStoreProcesses();
        expect(observed.status).toBe('busy');
        if (observed.status === 'busy')
          expect(
            observed.matches.some((current) =>
              oldServices.some(
                (old) => current.pid === old.pid && current.startIdentity === old.startIdentity,
              ),
            ),
          ).toBe(false);

        await desktop.page
          .getByText('Old TUI writes while Desktop waits.', { exact: false })
          .first()
          .waitFor({ timeout: 60_000 });
        await desktop.page
          .locator('.session-row')
          .filter({ hasText: 'Old TUI writes while Desktop waits.' })
          .click();
        await desktop.page
          .getByText('Old TUI remained writable while Desktop waited.', { exact: false })
          .waitFor({ timeout: 30_000 });
        expect(model.getRequestCount()).toBe(1);
        expect(existsSync(historical)).toBe(false);
        expect(captureHistory(canonical)).toEqual(oldHistory);
      } finally {
        await desktop.close();
      }
    } finally {
      await oldTui?.killAndWait().catch(() => undefined);
      model.stop();
      rmSync(application, { recursive: true, force: true });
      workspace.cleanup();
    }
  },
  180_000,
);
