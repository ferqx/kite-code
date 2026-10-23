import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

export async function runRecoveryPTY(
  config: Configuration,
  homeEnvironment: Record<string, string> = {},
) {
  const driver = Bun.spawn(
    [process.execPath, '--no-install', fileURLToPath(import.meta.url), JSON.stringify(config)],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...homeEnvironment },
    },
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
  const automaticRecovery = async () => {
    await key('\x1b');
    await wait('Session s');
    const end = Date.now() + 10000;
    const phase = config.mode === 'interrupt' ? 'interrupted' : 'resumed';
    for (;;) {
      const journal = JSON.parse(
        readFileSync(join(config.profilePath, 'ui/recovery.json'), 'utf8'),
      ) as Journal;
      if (journal.records.some((row) => row.phase === phase)) break;
      if (active.ended || Date.now() > end)
        throw Error('automatic original recovery GET not confirmed');
      await Bun.sleep(50);
    }
    await enterRecovery();
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
    await wait('Session s');
    if (config.mode !== 'report' && !config.cold) {
      // The real seed owner was killed. Initial activation must settle its
      // undispatched work before any explicit recovery may restore the frontier.
      await wait('owner_lost_before_dispatch');
      const database = new Database(join(config.profilePath, 'core.db'), { readonly: true });
      try {
        assert.deepEqual(
          database.query('SELECT status,is_active FROM run WHERE id=?').get(config.runId!),
          { status: 'interrupted', is_active: 0 },
        );
        assert.deepEqual(
          database.query('SELECT state FROM interaction WHERE id=?').get(config.cardId!),
          { state: 'cancelled' },
        );
        assert.deepEqual(
          database
            .query(
              "SELECT state,json_extract(result_json,'$.code') AS code FROM execution WHERE run_id=? AND adapter_id='files.write'",
            )
            .all(config.runId!),
          [{ state: 'cancelled', code: 'owner_lost_before_dispatch' }],
        );
      } finally {
        database.close();
      }
      assert.equal(existsSync(join(config.root, 'workspace/effect')), false);
      assert.equal(readFileSync(join(config.root, 'model-ledger'), 'utf8'), 'decision\n');
    }
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
      const database = new Database(join(config.profilePath, 'core.db'), { readonly: true });
      let originalOwner: string;
      let originalActive: boolean;
      try {
        const session = database
          .query('SELECT CAST(owner_generation AS TEXT) AS generation FROM session WHERE id=?')
          .get(original.sessionId) as { generation: string };
        originalOwner = session.generation;
        originalActive = !!database
          .query('SELECT id FROM run WHERE session_id=? AND is_active=1')
          .get(original.sessionId);
      } finally {
        database.close();
      }
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
      await automaticRecovery();
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
        body?: {
          kind?: string;
          commandId?: string;
          expectedStoreId?: string;
          expectedOwnerGeneration?: string;
        };
      }[];
      const writes = rows.filter(
        (row) =>
          row.method === 'POST' && ['run.resume', 'session.recover'].includes(row.body?.kind ?? ''),
      );
      assert.equal(writes.length, 1);
      assert.equal(writes[0]!.pid, warm);
      const coldPosts = rows.filter((row) => row.pid === cold && row.method === 'POST');
      const reconciliations = coldPosts.filter(
        (row) => row.path === `/v1/sessions/${original.sessionId}/reconcile`,
      );
      // Cold Host admission and initial selection reconcile one frozen scope.
      // The original recovery operation itself must remain strictly GET-only.
      assert.equal(reconciliations.length, 2);
      const generations = [
        originalOwner,
        String(BigInt(originalOwner) + (originalActive ? 1n : 0n)),
      ];
      // Reconciliation of an interrupted active Run fences its previous owner.
      // Initial selection then uses that observed new generation, never a retry
      // of the saved recovery operation or a new business command.
      for (const [index, row] of reconciliations.entries()) {
        const expectedOwnerGeneration = generations[index]!;
        const digest: string = createHash('sha256')
          .update(
            JSON.stringify([
              original.request.expectedStoreId,
              original.sessionId,
              expectedOwnerGeneration,
            ]),
          )
          .digest('hex');
        assert.deepEqual(row.body, {
          commandId: `session-reconcile-${digest}`,
          expectedStoreId: original.request.expectedStoreId,
          expectedOwnerGeneration,
        });
      }
      assert.deepEqual(
        coldPosts.filter((row) => !reconciliations.includes(row)),
        [],
      );
      assert.ok(
        rows.some(
          (row) => row.pid === cold && row.path === `/v1/commands/${original.request.commandId}`,
        ),
      );
      console.log('COLD_ORIGINAL_JOURNAL_ONLY_GET');
    } else {
      if (config.mode !== 'report') assert.ok(existsSync(join(config.root, 'lost')));
      await key('\x03');
      await automaticRecovery();
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
