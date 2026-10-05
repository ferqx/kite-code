import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
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
const priorSha = '6d9ffc07b069d4314970727c0a74ef0b62ed0990e4298805119953c25efda8ef';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Manifest = {
  name: string;
  version: string;
  exports: Record<string, string>;
  scripts: { build: string };
  dependencies?: Record<string, string>;
};
type FixtureExecution = {
  id: string;
  kind: string;
  status: string;
  definitionVersion: string;
  originStoreId: string;
  rootWorkCommandId: string;
  result: { content: string; details: { adapterAttempted: boolean } };
};
type FixtureView = {
  payload: { operation: { key: string }; execution: FixtureExecution };
  artifactRefs: unknown[];
};
type Evidence = {
  mode: string;
  storeId: string;
  command: { status: string };
  stage: { receipt: { status: string } };
  runs: { status: string; requirements: { extensionId: string; recordKey: string }[] }[];
  executions: FixtureExecution[];
  records: { contentType: string; originStoreId: string; value: { accepted: boolean } }[];
  views: FixtureView[];
  before: FixtureView[];
  after: FixtureView[];
  stats: { starts: number; cancels: number };
  modelCalls: number;
  body: { equals?: boolean; size: number; digest: string } | null;
  approvals: string[];
  accept: unknown;
  cursorBefore: string;
  cursorAfter: string;
  ledgerUnchanged: boolean;
  ledger: string;
  priorDigest: string;
  source: string;
};
function present<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value === null || value === undefined) throw Error('actual_fixture_evidence_missing');
  return value;
}
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
  const root = mkdtempSync('/private/tmp/kite-unseen-distribution-');
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
  const extension = join(directory, 'capsule');
  await build(join(repository, 'tests/fixtures/extensions/unseen-capsule'), extension);
  expect(existsSync(join(extension, 'node/worker.js'))).toBe(true);
  const prior = join(directory, 'prior-counted-v1.js');
  cpSync(
    join(repository, 'tests/fixtures/extensions/unseen-compat-prior/counted-tool-v1.js'),
    prior,
  );
  expect(sha(readFileSync(prior))).toBe(priorSha);
  expect(existsSync(join(modules, '@kite-ai/agent/src'))).toBe(false);
  expect(existsSync(join(modules, '@kite-ai/agent/storage/worker/main.js'))).toBe(true);
  expect(existsSync(join(modules, '@kite-ai/agent/storage/migrations/0001-baseline.sql'))).toBe(
    true,
  );
  const node = Bun.which('node');
  if (!node) throw Error('qualified_node_unavailable');
  const nodeProbe = join(directory, 'node-probe.mjs');
  writeFileSync(
    nodeProbe,
    `import {createCapsule} from './capsule/index.js'; import {defineExtension} from '@kite-ai/agent/extensions'; const value=createCapsule({root:'no-io-probe',nodePath:'unused',workerPath:'unused'}); console.log(JSON.stringify({id:value.extension.id,tools:value.extension.tools.length,actions:value.extension.actions.length,jobs:value.extension.jobs.length,conditions:!!value.extension.conditions,same:defineExtension(value.extension)===value.extension}));`,
  );
  const probe = JSON.parse(await child([node, nodeProbe], directory));
  expect(probe).toEqual({
    id: 'fixture.unseen-capsule',
    tools: 1,
    actions: 4,
    jobs: 1,
    conditions: true,
    same: true,
  });
  expect(existsSync(join(directory, 'no-io-probe'))).toBe(false);
  return {
    root,
    directory,
    extension,
    node,
    prior,
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
            prior,
          ],
          directory,
          20000,
        ),
      ) as Evidence;
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('E01/E02/E14 unseen capsule uses source-tree-external public manifests, actual Ask, requirement, Node Job, full Artifact and mutable Action; cold reads replay nothing', async () => {
  const built = await distribution();
  try {
    const root = join(built.root, 'positive');
    const first = await built.run('positive', root);
    if (first.runs[0]?.status !== 'completed')
      console.error(
        'actual_unseen_failure',
        JSON.stringify({
          command: first.command,
          runs: first.runs,
          executions: first.executions,
          approvals: first.approvals,
          stats: first.stats,
          views: first.views,
        }),
      );
    expect(first.command.status).toBe('applied');
    expect(first.runs).toHaveLength(1);
    const firstRun = present(first.runs[0]);
    expect(firstRun.status).toBe('completed');
    expect(first.stats).toEqual({ starts: 1, cancels: 0 });
    expect(first.modelCalls).toBe(2);
    const firstBody = present(first.body);
    expect(firstBody.equals).toBe(true);
    expect(firstBody.size).toBeGreaterThan(65536);
    expect(first.approvals).toContain('fixture.unseen-capsule.require');
    expect(first.approvals).toContain('fixture.unseen-capsule.pack');
    if (!first.approvals.includes('fixture.unseen-capsule/accept'))
      console.error(
        'actual_accept_diagnostic',
        JSON.stringify({ accept: first.accept, records: first.records }),
      );
    expect(first.approvals).toContain('fixture.unseen-capsule/accept');
    const job = present(first.executions.find((e) => e.kind === 'job'));
    expect(job.status).toBe('succeeded');
    expect(job.definitionVersion).toBe('1');
    expect(job.originStoreId).toBe(first.storeId);
    expect(job.rootWorkCommandId).toBe('work');
    expect(
      present(first.records.find((r) => r.contentType.endsWith('.request'))).originStoreId,
    ).toBe(first.storeId);
    expect(
      present(first.records.find((r) => r.contentType.endsWith('.acceptance'))).value.accepted,
    ).toBe(true);
    expect(firstRun.requirements).toHaveLength(1);
    const cold = await built.run('cold', root);
    expect(cold.storeId).toBe(first.storeId);
    expect(cold.command).toEqual(first.command);
    expect(cold.views).toEqual(first.views);
    expect(cold.body).toEqual({ size: firstBody.size, digest: firstBody.digest });
    expect(cold.stats).toEqual({ starts: 0, cancels: 0 });
    expect(cold.modelCalls).toBe(0);
    expect(cold.approvals).toEqual([]);
    expect(cold.cursorAfter).toBe(cold.cursorBefore);
    expect(cold.ledgerUnchanged).toBe(true);
  } finally {
    built.close();
  }
}, 30000);

test('unseen deny preserves zero effect and missing ordinary condition implementation retains the actual completion obligation', async () => {
  const built = await distribution();
  try {
    const denied = await built.run('deny', join(built.root, 'denied'));
    expect(denied.stats.starts).toBe(0);
    expect(denied.views).toEqual([]);
    expect(denied.records).toEqual([]);
    expect(
      denied.executions.filter((e) => e.kind === 'tool').every((e) => e.status !== 'succeeded'),
    ).toBe(true);
    expect(denied.approvals).toEqual(['fixture.unseen-capsule.require']);
    const missing = await built.run('missing', join(built.root, 'missing'));
    const missingRun = present(missing.runs[0]);
    expect(missingRun.status).toBe('failed');
    expect(missingRun.requirements).toHaveLength(1);
    const obligation = present(missingRun.requirements[0]);
    expect(obligation.extensionId).toBe('fixture.unseen-capsule');
    expect(obligation.recordKey).toBe('capsule/main/request');
    expect(
      missing.records.some(
        (r) => r.contentType.endsWith('.request') && r.originStoreId === missing.storeId,
      ),
    ).toBe(true);
    expect(missing.body).toBeNull();
    expect(missing.executions.some((e) => e.status === 'succeeded' && e.kind === 'job')).toBe(
      false,
    );
  } finally {
    built.close();
  }
}, 30000);

test('unseen detached original Jobs remain separate from Action completion and exact cancel stops only the first owned Node process', async () => {
  const built = await distribution();
  try {
    const detached = await built.run('detach', join(built.root, 'detached'));
    expect(detached.stats).toEqual({ starts: 2, cancels: 0 });
    expect(detached.modelCalls).toBe(0);
    expect(detached.before).toHaveLength(2);
    expect(detached.before.every((v) => v.payload.execution.status === 'running')).toBe(true);
    expect(
      detached.after.every(
        (v) => v.payload.execution.status === 'succeeded' && v.artifactRefs.length === 1,
      ),
    ).toBe(true);
    expect(detached.ledger.match(/effect:/g)).toHaveLength(2);
    const canceled = await built.run('cancel', join(built.root, 'canceled'));
    expect(canceled.stats).toEqual({ starts: 2, cancels: 1 });
    expect(canceled.modelCalls).toBe(0);
    const one = present(canceled.after.find((v) => v.payload.operation.key === 'one')),
      two = present(canceled.after.find((v) => v.payload.operation.key === 'two'));
    expect(one.payload.execution.status).toBe('cancelled');
    expect(one.artifactRefs).toEqual([]);
    expect(two.payload.execution.status).toBe('succeeded');
    expect(two.artifactRefs).toHaveLength(1);
    expect(canceled.ledger).not.toContain('effect:one:');
    expect(canceled.ledger.match(/effect:two:/g)).toHaveLength(1);
    expect(one.payload.execution.id).not.toBe(two.payload.execution.id);
    expect(
      canceled.approvals.filter((id: string) => id === 'fixture.unseen-capsule.pack'),
    ).toHaveLength(2);
    expect(canceled.approvals).toContain('fixture.unseen-capsule/cancel');
  } finally {
    built.close();
  }
}, 30000);

test('E11 existing counted-tool 1.0.0 built bytes run unchanged on current public host and cold history does not replay', async () => {
  const built = await distribution();
  try {
    const root = join(built.root, 'prior');
    const first = await built.run('compat', root);
    expect(first.priorDigest).toBe(priorSha);
    expect(present(first.runs[0]).status).toBe('completed');
    expect(first.executions).toHaveLength(1);
    const priorExecution = present(first.executions[0]);
    expect(priorExecution.definitionVersion).toBe('1.0.0');
    expect(priorExecution.status).toBe('succeeded');
    expect(priorExecution.result).toMatchObject({
      outcome: 'succeeded',
      content: 'counted:prior-bytes',
    });
    expect(first.ledger.trim().split('\n')).toHaveLength(1);
    expect(first.approvals).toEqual(['fixture.count']);
    const cold = await built.run('compat-cold', root);
    expect(cold.priorDigest).toBe(priorSha);
    expect(cold.storeId).toBe(first.storeId);
    expect(cold.command).toEqual(first.command);
    expect(cold.modelCalls).toBe(0);
    expect(cold.ledgerUnchanged).toBe(true);
    expect(cold.cursorAfter).toBe(cold.cursorBefore);
  } finally {
    built.close();
  }
}, 30000);

test('already-dispatched Action consumes its prepare record proof but original external source drift after independent Job Ask still prevents its adapter', async () => {
  const built = await distribution();
  try {
    const drift = await built.run('source-drift', join(built.root, 'source-drift'));
    expect(drift.stage.receipt.status).toBe('succeeded');
    expect(drift.stats).toEqual({ starts: 0, cancels: 0 });
    expect(drift.modelCalls).toBe(0);
    expect(drift.approvals).toEqual([
      'fixture.unseen-capsule/stage',
      'fixture.unseen-capsule.pack',
    ]);
    expect(drift.views).toHaveLength(1);
    const driftView = present(drift.views[0]);
    expect(driftView.payload.execution.status).toBe('failed');
    expect(driftView.payload.execution.result.content).toBe('context_refresh_required');
    expect(driftView.payload.execution.result.details).toMatchObject({
      adapterAttempted: false,
    });
    expect(driftView.artifactRefs).toEqual([]);
    expect(drift.source).toBe('changed applicable project source');
  } finally {
    built.close();
  }
}, 30000);
