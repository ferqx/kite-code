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
import { dirname, join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../../..');

type Manifest = {
  name: string;
  version: string;
  exports: Record<string, string>;
  scripts: { build: string };
  dependencies?: Record<string, string>;
};
async function child(command: string[], cwd: string, deadlineMs = 20000) {
  const process = Bun.spawn(command, { cwd, env: {}, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => process.kill('SIGKILL'), deadlineMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (code !== 0)
      throw Error(`external_fixture_failed:${code}\n${stderr}\n${stdout.slice(-4000)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (process.exitCode === null) {
      process.kill('SIGKILL');
      await process.exited;
    }
  }
}

type Snapshot = {
  storeId: string;
  session: { ownerGeneration: string };
  views: { payload: { execution: { id: string; status: string; result: unknown } } }[];
  executions: {
    id: string;
    definitionId: string;
    status: string;
    reference: Record<string, unknown> | null;
    result: { content: string; outcome: string; details?: unknown };
    resultRevision: string;
  }[];
  metadata: { lastChangeCursor: string };
  ledger: string;
  stats: { starts: number; cancels: number; reconciles: number };
  approvals: string[];
  producerDisposals: number;
  window: { window: string; executionId: string; pid?: number };
};
const producer = (snapshot: Snapshot) =>
  snapshot.executions.find((value) => value.definitionId === 'fixture.deferred-job.work')!;
async function wait(path: string, deadlineMs = 10000) {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw Error(`owned_file_deadline:${path}`);
    await Bun.sleep(5);
  }
}
async function dead(pid: number) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as { code?: string }).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() > deadline) throw Error('owned_pid_exit_unconfirmed');
    await Bun.sleep(5);
  }
}
async function warm(built: Awaited<ReturnType<typeof distribution>>, root: string, mode: string) {
  mkdirSync(root, { recursive: true });
  const host = Bun.spawn(
    [
      process.execPath,
      join(built.extension, 'host.js'),
      root,
      mode,
      built.node,
      join(built.extension, 'node/worker.js'),
    ],
    { cwd: built.directory, env: {}, stdout: 'pipe', stderr: 'pipe' },
  );
  built.own(host);
  const stdout = new Response(host.stdout).text(),
    stderr = new Response(host.stderr).text();
  try {
    await wait(join(root, 'ready.json'));
    const snapshot = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8')) as Snapshot;
    return {
      snapshot,
      async kill() {
        host.kill('SIGKILL');
        await host.exited;
        expect(await stderr).toBe('');
        expect(await stdout).toBe('');
        writeFileSync(join(root, 'killed.json'), JSON.stringify(snapshot));
      },
      async close() {
        writeFileSync(join(root, 'external/finish-host'), 'done');
        expect(await host.exited).toBe(0);
        expect(await stderr).toBe('');
      },
      host,
    };
  } catch (error) {
    host.kill('SIGKILL');
    await host.exited;
    throw Error(`${String(error)}\n${await stderr}\n${await stdout}`);
  }
}
async function cleanupWorker(root: string) {
  const started = join(root, 'external/started.json');
  if (!existsSync(started)) return;
  const identity = JSON.parse(readFileSync(started, 'utf8')) as {
    pid: number;
    executionId: string;
    token: string;
  };
  expect(identity.token).toBe(createHash('sha256').update(identity.executionId).digest('hex'));
  try {
    process.kill(identity.pid, 'SIGTERM');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ESRCH') throw error;
  }
  await dead(identity.pid);
}
for (const mode of ['before', 'after-spawn', 'terminal'] as const)
  test(`deferred-job actual SIGKILL ${mode} window preserves original facts; cold queries do not replay an unrecorded launch`, async () => {
    const built = await distribution(),
      root = join(built.root, mode);
    try {
      const active = await warm(built, root, mode),
        original = producer(active.snapshot);
      expect(active.snapshot.window.window).toBe(mode);
      expect(active.snapshot.approvals).toContain('fixture.deferred-job/launch');
      expect(active.snapshot.approvals).toContain('fixture.deferred-job.work');
      expect(original.status).toBe(mode === 'terminal' ? 'succeeded' : 'dispatching');
      if (mode === 'terminal') expect(original.reference).not.toBeNull();
      else expect(original.reference).toBeNull();
      if (mode === 'before') {
        expect(active.snapshot.ledger).toBe('');
        expect(existsSync(join(root, 'external/started.json'))).toBe(false);
      } else expect(active.snapshot.ledger.match(/start:/g)).toHaveLength(1);
      await active.kill();
      if (mode === 'after-spawn') {
        writeFileSync(join(root, 'external/release'), 'finish original worker');
        await wait(join(root, 'external/eof.json'));
        await dead(Number(active.snapshot.window.pid));
      }
      const cold = (await built.run('cold', root)) as { before: Snapshot; after: Snapshot };
      expect(cold.after).toEqual(cold.before);
      expect(producer(cold.before)).toEqual(original);
      expect(cold.before.stats).toEqual({ starts: 0, cancels: 0, reconciles: 0 });
      expect(cold.before.approvals).toEqual([]);
      if (mode === 'terminal') {
        expect(active.snapshot.producerDisposals).toBe(0);
        const eof = JSON.parse(readFileSync(join(root, 'external/eof.json'), 'utf8'));
        expect(original.reference).toMatchObject({
          token: eof.token,
          executionId: eof.executionId,
          pid: eof.pid,
        });
        expect(original.result.content).toBe(
          readFileSync(join(root, 'external/result.txt'), 'utf8'),
        );
        expect(createHash('sha256').update(original.result.content).digest('hex')).toBe(eof.digest);
        expect(cold.before.ledger.match(/effect:/g)).toHaveLength(1);
      } else {
        const recovered = (await built.run('recover', root)) as {
          before: Snapshot['executions'][number];
          reconcile: { rejected: string };
          duplicate: unknown;
          after: Snapshot;
        };
        expect(recovered.before.status).toBe('outcome_unknown');
        expect(recovered.before.reference).toBeNull();
        expect(recovered.reconcile).toEqual({ rejected: 'job_reconciliation_unavailable' });
        expect(recovered.duplicate).toEqual(recovered.reconcile);
        expect(recovered.after.stats.starts).toBe(0);
        expect(producer(recovered.after).status).toBe('outcome_unknown');
        expect(producer(recovered.after).reference).toBeNull();
      }
    } finally {
      await cleanupWorker(root);
      await built.close();
    }
  }, 30000);

test('recorded original deferred reference reconciles only matching external EOF; duplicate reconciliation and repeated cold queries do not start a process', async () => {
  const built = await distribution(),
    root = join(built.root, 'running');
  try {
    const active = await warm(built, root, 'running'),
      original = producer(active.snapshot);
    expect(original.status).toBe('running');
    expect(original.reference).not.toBeNull();
    await active.kill();
    writeFileSync(join(root, 'external/release'), 'finish recorded producer');
    await wait(join(root, 'external/eof.json'));
    await dead(Number(original.reference!.pid));
    const recovered = (await built.run('recover', root)) as {
      before: Snapshot['executions'][number];
      reconcile: { receipt: { outcome: string; result: { content: string } } };
      duplicate: unknown;
      after: Snapshot;
    };
    expect(recovered.before.status).toBe('outcome_unknown');
    expect(recovered.before.reference).toEqual(original.reference);
    expect(recovered.reconcile.receipt.outcome).toBe('verified');
    expect(recovered.reconcile.receipt.result.content).toBe(
      readFileSync(join(root, 'external/result.txt'), 'utf8'),
    );
    expect(recovered.duplicate).toEqual(recovered.reconcile);
    expect(recovered.after.stats).toEqual({ starts: 0, cancels: 0, reconciles: 1 });
    expect(recovered.after.ledger.match(/start:/g)).toHaveLength(1);
    expect(recovered.after.ledger.match(/effect:/g)).toHaveLength(1);
    const cold = (await built.run('cold', root)) as { before: Snapshot; after: Snapshot };
    expect(cold.after).toEqual(cold.before);
    expect(cold.before.ledger).toBe(recovered.after.ledger);
    expect(cold.before.stats.starts).toBe(0);
  } finally {
    await cleanupWorker(root);
    await built.close();
  }
}, 30000);

for (const mode of ['confirmed', 'requested'] as const)
  test(`deferred-job ${mode} stop distinguishes actual external exit from a request without confirmation`, async () => {
    const built = await distribution(),
      root = join(built.root, mode);
    try {
      const active = await warm(built, root, mode),
        original = producer(active.snapshot);
      expect(original.status).toBe(mode === 'confirmed' ? 'cancelled' : 'outcome_unknown');
      expect(original.reference).not.toBeNull();
      expect(active.snapshot.stats.starts).toBe(1);
      expect(active.snapshot.stats.cancels).toBeGreaterThan(0);
      expect(active.snapshot.ledger).not.toContain('effect:');
      if (mode === 'confirmed') {
        expect(existsSync(join(root, 'external/eof.json'))).toBe(true);
        await dead(Number(original.reference!.pid));
        await active.close();
      } else {
        expect(existsSync(join(root, 'external/eof.json'))).toBe(false);
        expect(() => process.kill(Number(original.reference!.pid), 0)).not.toThrow();
        await active.kill();
      }
      const cold = (await built.run('cold', root)) as { before: Snapshot; after: Snapshot };
      expect(cold.after).toEqual(cold.before);
      expect(producer(cold.before).status).toBe(original.status);
      expect(cold.before.stats.starts).toBe(0);
      expect(cold.before.ledger.match(/start:/g)).toHaveLength(1);
    } finally {
      await cleanupWorker(root);
      await built.close();
    }
  }, 30000);

test('a mismatched real EOF never verifies the original deferred reference; the saved unresolved receipt does not retry and only a new explicit observation can verify restored evidence', async () => {
  const built = await distribution(),
    root = join(built.root, 'mismatched');
  try {
    const active = await warm(built, root, 'running'),
      original = producer(active.snapshot);
    await active.kill();
    writeFileSync(join(root, 'external/release'), 'finish original producer');
    await wait(join(root, 'external/eof.json'));
    await dead(Number(original.reference!.pid));
    const path = join(root, 'external/eof.json'),
      correct = readFileSync(path, 'utf8'),
      eof = JSON.parse(correct);
    writeFileSync(path, JSON.stringify({ ...eof, token: '0'.repeat(64) }));
    const refused = (await built.run('recover', root)) as {
      reconcile: { receipt: { outcome: string } };
      duplicate: unknown;
      after: Snapshot;
    };
    expect(refused.reconcile.receipt.outcome).toBe('unresolved');
    expect(refused.duplicate).toEqual(refused.reconcile);
    expect(refused.after.stats).toEqual({ starts: 0, cancels: 0, reconciles: 1 });
    expect(producer(refused.after).status).toBe('outcome_unknown');
    expect(producer(refused.after).reference).toEqual(original.reference);
    writeFileSync(path, correct);
    const saved = (await built.run('recover', root)) as typeof refused;
    expect(saved.reconcile).toEqual(refused.reconcile);
    expect(saved.after.stats).toEqual({ starts: 0, cancels: 0, reconciles: 0 });
    const fresh = (await built.run('recover-fresh', root)) as typeof refused;
    expect(fresh.reconcile.receipt.outcome).toBe('verified');
    expect(fresh.duplicate).toEqual(fresh.reconcile);
    expect(fresh.after.stats).toEqual({ starts: 0, cancels: 0, reconciles: 1 });
    expect(fresh.after.ledger.match(/start:/g)).toHaveLength(1);
    expect(fresh.after.ledger.match(/effect:/g)).toHaveLength(1);
    const cold = (await built.run('cold', root)) as { before: Snapshot; after: Snapshot };
    expect(cold.after).toEqual(cold.before);
    expect(cold.before.stats).toEqual({ starts: 0, cancels: 0, reconciles: 0 });
    expect(cold.before.ledger).toBe(fresh.after.ledger);
  } finally {
    await cleanupWorker(root);
    await built.close();
  }
}, 30000);
async function build(source: string, destination: string) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Manifest;
  mkdirSync(destination, { recursive: true });
  for (const segment of manifest.scripts.build.split(/\s*&&\s*/)) {
    const words = segment.trim().split(/\s+/);
    if (words.shift() !== 'bun') throw Error('unsupported_real_manifest');
    const args = words.map((word) =>
      word === 'dist' || word === './dist'
        ? destination
        : word
            .replace(/^--outdir=(?:\.\/)?dist(?=\/|$)/, `--outdir=${destination}`)
            .replace(/^dist\/node$/, `${destination}/node`),
    );
    const index = args.indexOf('--outdir');
    if (index >= 0) args[index + 1] = args[index + 1]!.replace(/^\.\/dist(?=\/|$)/, destination);
    await child([process.execPath, ...args], source);
  }
  const exports = Object.fromEntries(
    Object.entries(manifest.exports).map(([name, path]) => [
      name,
      path.replace(/^\.\/src\//, './').replace(/\.ts$/, '.js'),
    ]),
  );
  writeFileSync(
    join(destination, 'package.json'),
    JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
  );
  for (const value of Object.values(exports))
    expect(existsSync(join(destination, value))).toBe(true);
  return manifest;
}
async function distribution() {
  const ownedHosts: {
    kill(signal: 'SIGKILL'): void;
    exited: Promise<number>;
    exitCode: number | null;
  }[] = [];
  const root = mkdtempSync('/private/tmp/kite-deferred-distribution-');
  const directory = join(root, 'application'),
    modules = join(directory, 'node_modules');
  mkdirSync(modules, { recursive: true });
  const dependencyOwners = new Map<string, string[]>();
  for (const [name, source] of [
    ['ai', 'packages/ai'],
    ['agent', 'packages/agent'],
    ['client', 'packages/client'],
    ['service', 'apps/service'],
  ] as const) {
    const manifest = await build(join(repository, source), join(modules, `@kite-ai/${name}`));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const owners = dependencyOwners.get(dependency) ?? [];
      owners.push(source);
      dependencyOwners.set(dependency, owners);
    }
  }
  for (const [dependency, owners] of dependencyOwners) {
    if (dependency.startsWith('@kite-ai/')) continue;
    const target = join(modules, dependency);
    mkdirSync(dirname(target), { recursive: true });
    const installed = [
      ...owners.map((owner) => join(repository, owner, 'node_modules', dependency)),
      join(repository, 'node_modules', dependency),
    ].find(existsSync);
    if (!installed) throw Error(`public_dependency_missing:${dependency}`);
    symlinkSync(realpathSync(installed), target, 'dir');
  }
  const extension = join(directory, 'deferred');
  await build(join(repository, 'tests/fixtures/extensions/deferred-job'), extension);
  expect(existsSync(join(extension, 'node/worker.js'))).toBe(true);
  expect(existsSync(join(modules, '@kite-ai/agent/src'))).toBe(false);
  expect(existsSync(join(modules, '@kite-ai/agent/storage/worker/main.js'))).toBe(true);
  expect(existsSync(join(modules, '@kite-ai/agent/storage/migrations/0001-baseline.sql'))).toBe(
    true,
  );
  const node = Bun.which('node');
  if (!node) throw Error('qualified_node_unavailable');
  return {
    root,
    own: (host: (typeof ownedHosts)[number]) => ownedHosts.push(host),
    directory,
    extension,
    node,
    async run(mode: string, profileRoot: string) {
      mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
      return JSON.parse(
        await child(
          [
            process.execPath,
            join(extension, 'host.js'),
            profileRoot,
            mode,
            node,
            join(extension, 'node/worker.js'),
          ],
          directory,
          20000,
        ),
      );
    },
    async close() {
      await Promise.all(
        ownedHosts.map(async (host) => {
          if (host.exitCode === null) {
            host.kill('SIGKILL');
            await host.exited;
          }
        }),
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}
