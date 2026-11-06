import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  CommandRecord,
  ExecutionOutputPage,
  ExecutionRecord,
  ExtensionRecord,
  Store,
} from '@kite-ai/agent/storage';
import {
  classifyWorktreeLiveVerification,
  completeJobOutput,
  finalizeWorktreeLiveAcceptance,
  newLiveOutputRoot,
  worktreeLiveShellReferenceEvidence,
} from '../../e2e/live/model/git-worktree-evidence';
import { persistentWorktreeDirectory } from '../../fixtures/worktree-filesystem';

test('late operator cancellation cannot qualify an otherwise successful closed live run', async () => {
  const controller = new AbortController();
  const checks = { businessCompleted: true, originalEvidenceRead: true, closeConfirmed: true };
  const options = { checks, failures: [], reviewRequirements: [], signal: controller.signal };
  expect(finalizeWorktreeLiveAcceptance(options)).toBe('assertions_passed');
  // Business checks have already passed. A signal can still arrive while the
  // original Runtime close or cold evidence read is awaited in finally.
  await Promise.resolve().then(() => controller.abort(null));
  expect(controller.signal.reason).toBeNull();
  expect(finalizeWorktreeLiveAcceptance(options)).toBe('needs_review');
  expect(checks).toMatchObject({
    businessCompleted: true,
    closeConfirmed: true,
    operatorNotCancelled: false,
  });
  expect(
    finalizeWorktreeLiveAcceptance({
      checks: { businessCompleted: true, closeConfirmed: false },
      failures: [],
      reviewRequirements: [],
    }),
  ).toBe('needs_review');
  expect(
    finalizeWorktreeLiveAcceptance({
      checks: { businessCompleted: true },
      failures: ['close:unknown'],
      reviewRequirements: [],
    }),
  ).toBe('needs_review');
});

test('live output rejects existing evidence and paths outside physical acceptance storage', () => {
  const root = persistentWorktreeDirectory('kite-live-root-check-');
  const fresh = join(root, 'fresh');
  expect(newLiveOutputRoot(fresh)).toBe(fresh);
  const existing = join(root, 'existing');
  writeFileSync(existing, 'original evidence\n');
  for (const path of ['relative', resolve('dist/acceptance'), resolve('dist/outside'), existing])
    expect(() => newLiveOutputRoot(path)).toThrow();
  expect(readFileSync(existing, 'utf8')).toBe('original evidence\n');
});

test.skipIf(process.platform === 'win32')(
  'live output rejects linked ancestors and dangling final entries',
  () => {
    const root = persistentWorktreeDirectory('kite-live-linked-root-');
    const physical = join(root, 'physical');
    mkdirSync(physical);
    const alias = join(root, 'alias');
    symlinkSync(physical, alias);
    expect(() => newLiveOutputRoot(join(alias, 'case'))).toThrow('physical-directory');
    const dangling = join(root, 'dangling');
    symlinkSync(join(root, 'missing'), dangling);
    expect(() => newLiveOutputRoot(dangling)).toThrow('new-absolute-acceptance-directory');
  },
);

for (const scenario of ['startup', 'late-home', 'wrong-userprofile', 'relative-provider'])
  test(`cached HOME guard fails before Git or Provider work: ${scenario}`, async () => {
    const output = join(persistentWorktreeDirectory('kite-live-home-check-'), 'case');
    const home = `${output}.home`;
    const helper = new URL('../../e2e/live/model/git-worktree-evidence.ts', import.meta.url).href;
    const probe = `
import {assertWorktreeLiveStartupHome} from ${JSON.stringify(helper)};
if (${JSON.stringify(scenario)} === 'late-home') {
  process.env.HOME = ${JSON.stringify(home)};
  process.env.USERPROFILE = ${JSON.stringify(home)};
}
let accepted = false;
try {
  assertWorktreeLiveStartupHome(${JSON.stringify(output)}, ${JSON.stringify(scenario === 'relative-provider' ? 'relative.jsonc' : join(output, 'original-provider.jsonc'))});
  accepted = true;
} catch {}
console.log(JSON.stringify({accepted}));
`;
    const child = Bun.spawn([process.execPath, '--eval', probe], {
      env: {
        HOME: scenario === 'late-home' ? `${home}-old` : home,
        USERPROFILE:
          scenario === 'late-home'
            ? `${home}-old`
            : scenario === 'wrong-userprofile'
              ? `${home}-wrong`
              : home,
        PATH: process.env.PATH ?? '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ accepted: scenario === 'startup' });
  });

test('verification oracle permits literal reads and refuses mutation, scripts and hidden execution', async () => {
  const cwd = resolve('dist/acceptance');
  for (const command of [
    'git worktree list --porcelain',
    'cd "/synthetic/工作目录" && git status --porcelain=v1 | head -5',
    'git -C /synthetic/source 2>/dev/null; test -e /synthetic/target || echo PATH_ABSENT',
    'git branch --list fixture && git rev-parse --verify refs/heads/fixture',
    'git --no-optional-locks -C /synthetic rev-parse --abbrev-ref HEAD',
    "git --no-optional-locks for-each-ref --format='%(refname) %(objectname)' refs/heads/fixture",
    'git --no-optional-locks tag --list | wc -l',
    "git --no-optional-locks status --porcelain --ignored | grep -c '^!!'",
    'git --no-pager stash list | wc -l',
  ])
    expect((await classifyWorktreeLiveVerification(command, cwd)).allowed, command).toBe(true);
  for (const command of [
    'git worktree add /synthetic/target',
    'git worktree remove /synthetic/target',
    'git branch -D fixture',
    'git branch --list --delete fixture',
    'git -c alias.verify="!git worktree add /tmp/tree" verify',
    'sh -c "git worktree add /tmp/tree"',
    'python -c "import os; os.system(\'git worktree add /tmp/tree\')"',
    'git worktree "$ACTION" /synthetic/target',
    'echo "$(git worktree add /synthetic/target)"',
    'git status > /synthetic/report',
    'git status 2>/synthetic/report',
    'git status &',
    'git --no-optional-locks -C /synthetic worktree add /synthetic/target',
    'git --no-optional-locks tag --list --delete fixture',
    'git --no-optional-locks tag fixture',
    'git --no-pager stash pop',
    'git --no-pager stash list --drop',
    'git --no-optional-locks hash-object -w /synthetic/file',
    'sort -o /synthetic/file',
  ])
    expect((await classifyWorktreeLiveVerification(command, cwd)).allowed, command).toBe(false);
  expect(
    await classifyWorktreeLiveVerification('P=/synthetic; git -C "$P" status', cwd),
  ).toMatchObject({ allowed: false, classification: 'requires_semantic_review' });
});

function shellReferenceFixture() {
  const ref = {
    commandId: 'command',
    executionId: 'job',
    extensionId: 'builtin.shell',
    key: 'original-key',
    originStoreId: 'store',
    sessionId: 'child',
  };
  const job = {
    id: 'job',
    originCommandId: 'command',
    originStoreId: 'store',
    sessionId: 'child',
    rootWorkCommandId: 'work',
    rootWorkSeq: '2',
    definitionId: 'shell.command',
    definitionVersion: '1',
    input: { command: 'git worktree list' },
  } as unknown as ExecutionRecord;
  const parent = {
    id: 'tool',
    result: { details: { shell_id: ref.key, ref: { ...ref } } },
  } as unknown as ExecutionRecord;
  const records = [
    {
      extensionId: 'builtin.shell',
      sessionId: 'child',
      key: `shell/${ref.key}`,
      contentType: 'application/vnd.kite.shell-reference+json',
      contentVersion: 1,
      value: { ref: { ...ref } },
    },
  ] as unknown as ExtensionRecord[];
  const command = {
    id: 'command',
    kind: 'operation.job',
    status: 'applied',
    originStoreId: 'store',
    sessionId: 'child',
    rootWorkCommandId: 'work',
    rootWorkSeq: '2',
    request: {
      kind: 'operation.job',
      extensionId: 'builtin.shell',
      operationKey: ref.key,
      parentExecutionId: parent.id,
      definitionId: 'shell.command',
      definitionVersion: '1',
      cancellation: 'attached',
      input: { command: 'git worktree list' },
    },
    receipt: { commandId: 'command', executionId: 'job' },
  } as unknown as CommandRecord;
  return { job, parent, records, command };
}

test('ordinary Shell evidence binds one original record, receipt, Job and applied Command', () => {
  const original = shellReferenceFixture();
  const verify = (value: ReturnType<typeof shellReferenceFixture>) =>
    worktreeLiveShellReferenceEvidence(value.job, value.parent, value.records, value.command);
  expect(verify(original)).toMatchObject({
    exactOriginalCommand: true,
    uniqueOriginalRecordAndReceipt: true,
  });
  const changes = [
    (x: typeof original) => x.records.push(structuredClone(x.records[0]!)),
    (x: typeof original) => {
      x.records[0]!.sessionId = 'other';
    },
    (x: typeof original) => {
      (x.records[0]!.value as { ref: { originStoreId: string } }).ref.originStoreId = 'other';
    },
    (x: typeof original) => {
      x.command.status = 'accepted';
    },
    (x: typeof original) => {
      x.command.rootWorkSeq = '3';
    },
    (x: typeof original) => {
      (x.command.request as { input: unknown }).input = { command: 'git worktree add /tmp/tree' };
    },
    (x: typeof original) => {
      (x.command.request as { cancellation: string }).cancellation = 'detached';
    },
    (x: typeof original) => {
      x.command.receipt = { commandId: 'command', executionId: 'replacement' };
    },
    (x: typeof original) => {
      x.parent.result = { details: { shell_id: 'new-key', ref: {} } };
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(original);
    change(changed);
    const proof = verify(changed);
    expect(proof.exactOriginalCommand && proof.uniqueOriginalRecordAndReceipt).toBe(false);
  }
  expect(
    worktreeLiveShellReferenceEvidence(original.job, original.parent, original.records, null)
      .exactOriginalCommand,
  ).toBe(false);
});

function outputPages(): ExecutionOutputPage[] {
  return [
    {
      highWaterSeq: '2',
      items: [
        {
          executionId: 'job',
          seq: '1',
          throughSeq: '1',
          stream: 'stdout',
          content: '{"ok":',
          droppedBytes: '0',
        },
      ],
    },
    {
      highWaterSeq: '2',
      items: [
        {
          executionId: 'job',
          seq: '2',
          throughSeq: '2',
          stream: 'stdout',
          content: 'true}\n',
          droppedBytes: '0',
        },
      ],
    },
  ];
}
function outputStore(pages: ExecutionOutputPage[]) {
  const reads: Parameters<Store['listExecutionOutput']>[0][] = [];
  return {
    reads,
    async listExecutionOutput(input: Parameters<Store['listExecutionOutput']>[0]) {
      reads.push(input);
      return pages[reads.length - 1]!;
    },
  };
}

test('live complete output pins its high water and consumes every original chunk', async () => {
  const store = outputStore(outputPages());
  expect(await completeJobOutput(store, 'job')).toMatchObject({
    complete: true,
    frame: { ok: true },
  });
  expect(store.reads).toEqual([
    { executionId: 'job', afterSeq: '0', limit: 200 },
    { executionId: 'job', afterSeq: '1', upperSeq: '2', limit: 200 },
  ]);
});

test('live complete output reads beyond a full 200-record page', async () => {
  const stdout = `${JSON.stringify({ content: 'original output '.repeat(30) })}\n`;
  const items = [...stdout].map((content, index) => ({
    executionId: 'job',
    seq: String(index + 1),
    throughSeq: String(index + 1),
    stream: 'stdout' as const,
    content,
    droppedBytes: '0',
  }));
  const highWaterSeq = String(items.length);
  const pages: ExecutionOutputPage[] = [];
  for (let index = 0; index < items.length; index += 200)
    pages.push({ highWaterSeq, items: items.slice(index, index + 200) });
  const store = outputStore(pages);
  const result = await completeJobOutput(store, 'job');
  expect(store.reads.length).toBeGreaterThan(1);
  expect(result.stdout).toBe(stdout);
  expect(result.frame).toEqual(JSON.parse(stdout));
});

test('live complete output refuses wrong Job, hidden gaps, moving water and malformed frames', async () => {
  const changes = [
    (x: ExecutionOutputPage[]) => {
      x[0]!.items[0]!.executionId = 'other';
    },
    (x: ExecutionOutputPage[]) => {
      x[0]!.items[0]!.throughSeq = '2';
    },
    (x: ExecutionOutputPage[]) => {
      x[0]!.items[0]!.droppedBytes = null;
    },
    (x: ExecutionOutputPage[]) => {
      x[0]!.items[0]!.droppedBytes = '1';
    },
    (x: ExecutionOutputPage[]) => {
      x[1]!.items[0]!.seq = '1';
    },
    (x: ExecutionOutputPage[]) => {
      x[1]!.items = [];
    },
    (x: ExecutionOutputPage[]) => {
      x[1]!.highWaterSeq = '3';
    },
    (x: ExecutionOutputPage[]) => {
      x[0]!.highWaterSeq = '-1';
    },
    (x: ExecutionOutputPage[]) => {
      x[0]!.items[0]!.seq = '01';
    },
    (x: ExecutionOutputPage[]) => {
      x[0]!.items[0]!.content = '\ud800';
    },
    (x: ExecutionOutputPage[]) => {
      x[1]!.items[0]!.content = 'true}\n{}\n';
    },
    (x: ExecutionOutputPage[]) => {
      x[1]!.items[0]!.content = 'true}';
    },
  ];
  for (const change of changes) {
    const pages = outputPages();
    change(pages);
    await expect(completeJobOutput(outputStore(pages), 'job')).rejects.toBeInstanceOf(Error);
  }
  const ordinary = outputPages();
  ordinary[0]!.items[0]!.content = 'arbitrary ordinary stdout\n';
  ordinary[1]!.items[0]!.stream = 'stderr';
  ordinary[1]!.items[0]!.content = 'diagnostic\n';
  expect(await completeJobOutput(outputStore(ordinary), 'job', 'shell')).toMatchObject({
    stdout: 'arbitrary ordinary stdout\n',
    stderr: 'diagnostic\n',
    complete: true,
    frame: null,
  });
});

test('Agent progress is retained separately and cannot masquerade as a Shell or worker frame', async () => {
  const content = JSON.stringify({ childSessionId: 'child', runId: 'original-run' });
  const pages: ExecutionOutputPage[] = [
    {
      highWaterSeq: '1',
      items: [
        {
          executionId: 'job',
          seq: '1',
          throughSeq: '1',
          stream: 'progress',
          content,
          droppedBytes: '0',
        },
      ],
    },
  ];
  expect(await completeJobOutput(outputStore(pages), 'job', 'agent')).toMatchObject({
    complete: true,
    stdout: '',
    stderr: '',
    frame: null,
    progress: [{ seq: '1', content }],
  });
  for (const mode of ['worktree', 'shell'] as const)
    await expect(completeJobOutput(outputStore(pages), 'job', mode)).rejects.toThrow(
      'unexpected-stream',
    );
});
