import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Terminal } from '@xterm/headless';

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

export function readFileRecoveryRender(screen: Terminal): string {
  return Array.from(
    { length: screen.buffer.active.length },
    (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? '',
  ).join('\n');
}

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

async function deadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    const screen = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    const output: Uint8Array[] = [];
    let parsed = Promise.resolve();
    let revision = 0;
    let actionRevision = -1;
    let actionOffset = 0;
    let byteLength = 0;
    let ended = false;
    let closed = false;
    let resolveEOF!: () => void;
    const eof = new Promise<void>((resolve) => {
      resolveEOF = resolve;
    });
    const host = Bun.spawn({
      cmd: [process.execPath, '--no-install', join(config.root, 'tui.js')],
      cwd: config.workspace,
      env: {
        ...process.env,
        HOME: config.home,
        ...(process.platform === 'win32' ? { USERPROFILE: config.home } : {}),
        WINDOW: window ?? '',
      },
      detached: process.platform !== 'win32',
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          const copy = bytes.slice();
          output.push(copy);
          transcript.push(copy);
          byteLength += copy.byteLength;
          parsed = parsed
            .then(() => new Promise<void>((resolve) => screen.write(copy, resolve)))
            .then(() => {
              revision++;
            });
        },
        exit() {
          resolveEOF();
        },
      },
    });
    const text = () => Buffer.concat(output).toString('utf8');
    void host.exited.then(() => {
      ended = true;
    });
    const sinceAction = () => Buffer.concat(output).subarray(actionOffset).toString('utf8');
    const viewport = () =>
      Array.from(
        { length: 24 },
        (_, row) =>
          screen.buffer.active
            .getLine(screen.buffer.active.viewportY + row)
            ?.translateToString(true) ?? '',
      ).join('\n');
    return {
      host,
      get ended() {
        return ended;
      },
      eof,
      text,
      sinceAction,
      viewport,
      async key(value: string) {
        await parsed;
        actionRevision = revision;
        actionOffset = byteLength;
        host.terminal!.write(value);
      },
      async projection() {
        await parsed;
        return { fresh: revision > actionRevision, text: readFileRecoveryRender(screen) };
      },
      async drain() {
        await parsed;
      },
      close() {
        if (closed) return;
        closed = true;
        host.terminal?.close();
        screen.dispose();
      },
    };
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
        (!options.approval || !frame.text.includes('Files recovery:'))
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
  const approveCode = async () => {
    await wait('pending approval panel');
    await wait('none (Enter has no answer)');
    await key('a');
    await wait('none (Enter has no answer)', { approval: true });
    await key('\x1b[B');
    await wait('only this call', { approval: true });
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
    assert.equal(owned.ended, false, 'original host must be alive before tree termination');
    const path = join(config.root, 'service.pid');
    const servicePid = existsSync(path) ? Number(readFileSync(path, 'utf8')) : undefined;
    if (requireService) {
      assert.ok(servicePid !== undefined && Number.isSafeInteger(servicePid) && servicePid > 0);
      process.kill(servicePid, 0);
    }
    if (process.platform === 'win32') {
      const result = Bun.spawnSync(['taskkill.exe', '/pid', String(owned.host.pid), '/t', '/f'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assert.equal(result.exitCode, 0, 'original host tree termination failed');
    } else {
      process.kill(-owned.host.pid, 'SIGKILL');
    }
    await deadline(
      Promise.all([owned.host.exited, owned.eof]),
      3000,
      'original host tree did not exit',
    );
    const end = Date.now() + 3000;
    if (servicePid === undefined) return;
    for (;;) {
      try {
        process.kill(servicePid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
        throw error;
      }
      if (Date.now() >= end) throw Error('original Service remains alive after tree termination');
      await Bun.sleep(50);
    }
    await owned.drain();
  };
  let failure: unknown;
  try {
    const crash = config.mode === 'before_post' || config.mode === 'between_legs';
    launch(crash ? config.mode : undefined);
    await wait('Session s');
    await key('/rewind');
    await wait('/rewind');
    await key('\r');
    await wait('Files recovery:');
    await wait(checkpoint);
    await key('\r');
    await wait('preimage');
    const scope = config.mode === 'session' ? 'session' : config.mode === 'code' ? 'code' : 'both';
    await key(scope === 'session' ? '1' : scope === 'code' ? '2' : '3');
    await wait(`Confirm ${scope}`);
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
      await wait(scope === 'code' ? 'Session s' : selected[0]!.fork!.request.newSessionId!);
    }
    await key('\x11');
    const end = Date.now() + 10000;
    while (!active.ended && Date.now() < end) await Bun.sleep(50);
    const [code] = await deadline(
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
