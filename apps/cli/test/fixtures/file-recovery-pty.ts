import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

type Mode = 'both' | 'lost' | 'session' | 'code' | 'before_post' | 'between_legs';
type Configuration = {
  root: string;
  workspace: string;
  home: string;
  profile: { profilePath: string };
  checkpointId: string;
  mode: Mode;
  transcript: string;
};
type Leg = { phase: string; request: { newSessionId?: string; [key: string]: unknown } };
type RecoveryRecord = { code: Leg | null; fork: Leg | null };

export async function runFileRecoveryPTY(
  fixture: Omit<Configuration, 'mode' | 'transcript'>,
  input: Pick<Configuration, 'mode' | 'transcript'>,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      fileURLToPath(import.meta.url),
      JSON.stringify({
        root: fixture.root,
        workspace: fixture.workspace,
        home: fixture.home,
        profile: { profilePath: fixture.profile.profilePath },
        checkpointId: fixture.checkpointId,
        ...input,
      }),
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

async function drive(config: Configuration) {
  const journal = join(config.profile.profilePath, 'ui/file-recovery-intents.json');
  const wire = join(config.root, 'wire');
  const checkpoint = config.checkpointId.slice(0, 24);
  const rows = () => JSON.parse(readFileSync(journal, 'utf8')).records as RecoveryRecord[];
  const transcript: Uint8Array[] = [];
  const hosts: ReturnType<typeof start>[] = [];
  let active!: ReturnType<typeof start>;
  function start(window?: string) {
    rmSync(join(config.root, 'service.pid'), { force: true });
    return spawnTuiPTY({
      cmd: [process.execPath, '--no-install', join(config.root, 'tui.js')],
      cwd: config.workspace,
      env: {
        HOME: config.home,
        ...(process.platform === 'win32' ? { USERPROFILE: config.home } : {}),
        WINDOW: window ?? '',
      },
      onData: (bytes) => transcript.push(bytes),
    });
  }
  const launch = (window?: string) => {
    active = start(window);
    hosts.push(active);
  };
  const normalized = (text: string) => text.replace(/\s+/g, '');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip actual PTY ANSI CSI bytes.
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
  const key = (value: string) => active.key(value);
  const wait = async (text: string, options: { approval?: boolean; material?: boolean } = {}) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const frame = await active.projection();
      // Ink's current render can exceed 24 rows. Its erase/clear sequences remove
      // older renders from this parsed buffer, including within the same action.
      const candidate = options.material ? active.text().replace(ansi, '') : frame.text;
      if (
        (options.material || frame.fresh) &&
        normalized(candidate).includes(normalized(text)) &&
        (!options.approval || !frame.text.includes('Files recovery'))
      )
        return;
      if (text === checkpoint && active.sinceAction().includes('server_reset')) await key('r');
      if (active.ended) throw Error(`host ended before ${text}`);
      await Bun.sleep(50);
    }
    throw Error(
      `expected ${text} viewport=${active.viewport()} tail=${active.text().slice(-8000)}`,
    );
  };
  const until = async <T>(read: () => T, matches: (value: T) => boolean, message: string) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const value = read();
      if (matches(value)) return value;
      await Bun.sleep(50);
    }
    throw Error(message);
  };
  const postCount = () =>
    readFileSync(wire, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.method === 'POST').length;
  const approveCode = async () => {
    await wait('pending approval panel');
    const beforeAnswer = postCount();
    await key('a');
    await wait('❯ Allow once', { approval: true });
    await key('\x1b[B');
    await wait('❯ Deny', { approval: true });
    await key('\x1b[A');
    await wait('❯ Allow once', { approval: true });
    assert.equal(postCount(), beforeAnswer, 'Viewing and selecting do not approve recovery');
    await key('\r');
    await wait('restored', { material: true });
    await wait('New Run >');
    await key('/rewind');
    await wait('/rewind');
    await key('\r');
    await wait('Saved 1:');
    await key('l');
  };
  const killTree = async (owned: ReturnType<typeof start>, requireService = true) => {
    const path = join(config.root, 'service.pid');
    const servicePid = existsSync(path) ? Number(readFileSync(path, 'utf8')) : undefined;
    if (requireService)
      assert.ok(servicePid !== undefined && Number.isSafeInteger(servicePid) && servicePid > 0);
    await terminateTuiTree(owned, {
      exitTimeoutMs: 3000,
      servicePid,
      serviceExitTimeoutMs: 3000,
      requireServiceAlive: requireService,
    });
  };
  let failure: unknown;
  try {
    const crash = config.mode === 'before_post' || config.mode === 'between_legs';
    launch(crash ? config.mode : undefined);
    await wait('Session s');
    await key('/rewind');
    await wait('/rewind');
    await key('\r');
    await wait('Files recovery');
    await wait(checkpoint);
    const beforePreview = postCount();
    await key('\r');
    await wait('original.txt');
    await wait('V: read text preview');
    await key('v');
    await wait('original bytes');
    await wait('Complete text preview');
    await key('\x1b');
    await wait('❯ 1. Session and code');
    assert.equal(
      postCount(),
      beforePreview,
      'Opening the original default-scope confirmation has no write',
    );
    const scope = config.mode === 'session' ? 'session' : config.mode === 'code' ? 'code' : 'both';
    await key(scope === 'session' ? '2' : scope === 'code' ? '3' : '1');
    await wait(
      `❯ ${scope === 'session' ? '2. Session only' : scope === 'code' ? '3. Code only' : '1. Session and code'}`,
    );
    await wait('Enter confirms selected scope');
    assert.equal(
      postCount(),
      beforePreview,
      'Selecting the original scope does not submit recovery',
    );
    await key('\r');
    if (config.mode === 'before_post') {
      await until(
        () => existsSync(join(config.root, 'marker')),
        Boolean,
        'beforepost marker missing',
      );
    } else if (scope !== 'session') {
      await approveCode();
      await wait(
        scope === 'code' ? '"phase":"succeeded"},"fork":null' : '"phase":"succeeded"},"fork"',
      );
    }
    if (crash) {
      const original = rows()[0]!;
      assert.equal(original.fork!.phase, 'not_started');
      await killTree(active);
      active.close();
      const before = readFileSync(wire, 'utf8').trimEnd().split('\n').length;
      launch();
      await wait('Session s');
      await key('/rewind');
      await wait('/rewind');
      await key('\r');
      await wait('Saved 1:');
      await key('l');
      await wait(
        config.mode === 'before_post' ? '"phase":"unknown"},"fork"' : '"phase":"succeeded"},"fork"',
      );
      const cold = rows()[0]!;
      assert.deepEqual(cold.code!.request, original.code!.request);
      assert.deepEqual(cold.fork!.request, original.fork!.request);
      assert.equal(cold.fork!.phase, 'not_started');
      const requests = readFileSync(wire, 'utf8')
        .trimEnd()
        .split('\n')
        .slice(before)
        .map((line) => JSON.parse(line));
      assert.ok(!requests.some((row) => row.method === 'POST'));
    } else {
      if (scope === 'both') {
        await key('c');
        if (config.mode === 'lost') {
          await wait('"phase":"unknown"}');
          await key('r');
        }
      }
      const selected = await until(
        () => (existsSync(journal) ? rows() : []),
        (records) => records[0]?.[scope === 'code' ? 'code' : 'fork']?.phase === 'succeeded',
        'second leg not succeeded',
      );
      if (scope === 'code') {
        await key('\x1b');
        await wait('Session s');
        await wait('New Run >');
      } else await wait(selected[0]!.fork!.request.newSessionId!);
    }
    await key('\x11');
    const end = Date.now() + 10000;
    while (!active.ended && Date.now() < end) await Bun.sleep(50);
    const [code] = await ptyDeadline(
      Promise.all([active.host.exited, active.eof]),
      3000,
      'host exit timeout',
    );
    assert.equal(code, 0);
    console.log(crash ? 'TUI_ORIGINAL_COLD_ONLY_GET' : 'FILE_BOTH_ORIGINAL_CONFIRMED');
  } catch (error) {
    failure = error;
  } finally {
    for (const owned of hosts) {
      try {
        if (!owned.ended) await killTree(owned, false);
        await owned.drain();
        owned.close();
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], 'Files PTY failed') : error;
      }
    }
    writeFileSync(config.transcript, Buffer.concat(transcript));
  }
  if (failure) throw failure;
}

if (import.meta.main) {
  try {
    await drive(JSON.parse(process.argv[2]!));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
