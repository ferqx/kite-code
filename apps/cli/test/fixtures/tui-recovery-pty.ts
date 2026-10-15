import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ptyDeadline, spawnTuiPTY, type TuiPTY, terminateTuiTree } from './tui-pty';

type Configuration = {
  root: string;
  runner: string;
  profilePath: string;
  network: string;
  pidPath: string;
  transcript: string;
  mode: 'run' | 'interrupt' | 'report';
  cold?: boolean;
  runId?: string;
  storeId?: string;
  cardId?: string;
  reportId?: string;
};
type Journal = {
  records: {
    phase: string;
    intent: { sessionId: string; request: { expectedStoreId: string; commandId: string } };
  }[];
};

export async function runRecoveryPTY(config: Configuration) {
  const driver = Bun.spawn(
    [process.execPath, '--no-install', fileURLToPath(import.meta.url), JSON.stringify(config)],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([
    new Response(driver.stdout).text(),
    new Response(driver.stderr).text(),
    driver.exited,
  ]);
  return { out, err, code };
}

async function drive(config: Configuration) {
  const output: Uint8Array[] = [];
  const hosts: TuiPTY[] = [];
  let active!: TuiPTY;
  const launch = () => {
    active = spawnTuiPTY({
      cmd: [process.execPath, '--no-install', config.runner],
      cwd: process.cwd(),
      onData: (bytes) => output.push(bytes),
    });
    hosts.push(active);
  };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Decode actual terminal material.
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
  const wait = async (text: string, material = false) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const frame = await active.projection();
      const content = material ? active.text().replace(ansi, '') : frame.text;
      if ((material || frame.fresh) && content.replace(/\s+/g, ' ').includes(text)) return;
      if (active.ended) throw Error(`host ended before ${text}`);
      await Bun.sleep(50);
    }
    throw Error(`expected ${text} tail=${active.text().slice(-5000)}`);
  };
  const key = (value: string) => active.key(value);
  const enterRecovery = async () => {
    await key('/recovery');
    await wait('/recovery');
    await key('\r');
    await wait('Explicit recovery');
  };
  const exitNormally = async () => {
    await key('\x11');
    const end = Date.now() + 6000;
    while (!active.ended && Date.now() < end) await Bun.sleep(50);
    const [code] = await ptyDeadline(
      Promise.all([active.host.exited, active.eof]),
      3000,
      'host exit timeout',
    );
    assert.equal(code, 0);
    await active.drain();
    active.close();
  };
  let failure: unknown;
  try {
    launch();
    await wait(
      config.mode === 'report' || config.cold
        ? 'Session s'
        : `approval [${config.cardId}] original Session s`,
    );
    await enterRecovery();
    const input =
      config.mode === 'run'
        ? `run ${config.runId}`
        : config.mode === 'report'
          ? `report ${config.reportId}`
          : 'interrupt confirm';
    await key(input);
    await wait(input);
    await key('\r');
    await wait('outcome_unknown');
    if (config.cold) {
      const saved = JSON.parse(
        readFileSync(join(config.profilePath, 'ui/recovery.json'), 'utf8'),
      ) as Journal;
      assert.equal(saved.records.length, 1);
      const original = saved.records[0]!.intent;
      assert.equal(original.sessionId, 's');
      assert.equal(original.request.expectedStoreId, config.storeId);
      assert.ok(['submitting', 'outcome_unknown'].includes(saved.records[0]!.phase));
      const warm = active.host.pid;
      await terminateTuiTree(active, {
        exitTimeoutMs: 3000,
        servicePid: Number(readFileSync(config.pidPath, 'utf8')),
        serviceExitTimeoutMs: 6000,
      });
      active.close();
      launch();
      const cold = active.host.pid;
      assert.notEqual(cold, warm);
      await wait('Session s');
      await key('/recovery');
      await wait('/recovery');
      await key('\r');
      await wait('outcome_unknown');
      await wait(original.request.commandId);
      await key('\x03');
      await Bun.sleep(100);
      await key('\x0c');
      await wait(config.mode === 'run' ? 'run · resumed' : 'interrupt · interrupted');
      await wait(original.request.commandId);
      await exitNormally();
      const rows = readFileSync(config.network, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)) as {
        pid: number;
        method: string;
        path: string;
        body?: { kind?: string };
      }[];
      const writes = rows.filter(
        (row) =>
          row.method === 'POST' && ['run.resume', 'session.recover'].includes(row.body?.kind ?? ''),
      );
      assert.equal(writes.length, 1);
      assert.equal(writes[0]!.pid, warm);
      assert.equal(rows.filter((row) => row.pid === cold && row.method === 'POST').length, 0);
      assert.ok(
        rows.some(
          (row) => row.pid === cold && row.path === `/v1/commands/${original.request.commandId}`,
        ),
      );
      console.log('COLD_ORIGINAL_JOURNAL_ONLY_GET');
    } else {
      if (config.mode !== 'report') assert.ok(existsSync(join(config.root, 'lost')));
      await key('\x03\x0c');
      await wait(
        config.mode === 'run'
          ? 'run · resumed'
          : config.mode === 'report'
            ? 'report · resumed'
            : 'interrupt · interrupted',
      );
      if (config.mode === 'run') {
        await key('\x1b');
        await wait('Tool approval');
        await wait(config.cardId!.slice(0, 24));
        await key('\x1b[B');
        await wait('❯ Deny');
        await key('\x1b[B');
        await wait('❯ Allow once');
        await wait('Approve this execution only');
        await key('\r');
        await wait('RECOVERED_ORIGINAL_DONE', true);
      } else if (config.mode === 'report') {
        await key('\x1b');
        await wait('REPORT_ORIGINAL_CHILD_DONE', true);
      }
      await exitNormally();
      console.log(
        config.mode === 'report' ? 'ORIGINAL_REPORT_RUN_CONFIRMED' : 'ORIGINAL_RECOVERY_CONFIRMED',
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const owned of hosts) {
      try {
        if (!owned.ended) await terminateTuiTree(owned, { exitTimeoutMs: 3000 });
        await owned.drain();
        owned.close();
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], 'Recovery PTY failed') : error;
      }
    }
    writeFileSync(config.transcript, Buffer.concat(output));
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
