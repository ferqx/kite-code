import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CommandRecord, SessionView, StoreMetadata } from '@kite-ai/agent/storage';

const childEntry = resolve(import.meta.dir, '../../fixtures/unified-agent/process.ts');
const extensionEntry = resolve(
  import.meta.dir,
  '../../fixtures/extensions/counted-tool/src/index.ts',
);
interface Evidence {
  metadata: StoreMetadata;
  command: CommandRecord;
  view: SessionView;
  modelRequests: number;
  requestCount?: number;
  conflict?: string | null;
  otherRunStatus?: string;
}

async function processEvidence(
  mode: string,
  root: string,
  extensionPath: string,
): Promise<Evidence> {
  const child = Bun.spawn(
    [
      process.execPath,
      childEntry,
      mode,
      join(root, 'data'),
      'disposable',
      join(root, 'invocations.jsonl'),
      extensionPath,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        KITE_CODE_HOME: join(root, 'old-kite-data'),
      },
    },
  );
  const deadline = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    return JSON.parse(stdout.trim()) as Evidence;
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-unified-p1-'));
  const build = await Bun.build({
    entrypoints: [extensionEntry],
    target: 'bun',
    outdir: join(root, 'extension'),
  });
  if (!build.success) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(build.logs.map(String).join('\n'));
  }
  const extensionPath = join(root, 'extension', 'index.js');
  const sentinel = join(root, 'old-kite-data');
  writeFileSync(sentinel, 'Do not read or migrate old user data.\n', { mode: 0o600 });
  return { root, extensionPath, sentinel, before: statSync(sentinel) };
}

function invocations(root: string): unknown[] {
  const path = join(root, 'invocations.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function expectSameFacts(reopened: Evidence, executed: Evidence): void {
  expect(reopened.view.session.id).toBe(executed.view.session.id);
  expect(reopened.view.session.title).toBe(executed.view.session.title);
  expect(reopened.view.runs).toEqual(executed.view.runs);
  expect(reopened.view.executions).toEqual(executed.view.executions);
  expect(reopened.view.messages).toEqual(executed.view.messages);
}

test('P1 external counted-tool persists original identities across a real process restart without replay', async () => {
  const data = await fixture();
  try {
    const executed = await processEvidence('allow', data.root, data.extensionPath);
    expect(executed.command.id).toBe('work-1');
    expect(executed.command.status).toBe('applied');
    expect(executed.view.runs).toHaveLength(1);
    expect(executed.view.runs[0]!.status).toBe('completed');
    const tools = executed.view.executions.filter((execution) => execution.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('succeeded');
    expect(tools[0]!.result).toMatchObject({ outcome: 'succeeded', content: 'counted:hello' });
    expect(invocations(data.root)).toHaveLength(1);
    expect(executed.modelRequests).toBe(executed.requestCount!);
    expect(executed.conflict).toBeTruthy();

    const reopened = await processEvidence('read', data.root, data.extensionPath);
    expect(reopened.metadata.storeId).toBe(executed.metadata.storeId);
    expect(reopened.command).toEqual(executed.command);
    expectSameFacts(reopened, executed);
    expect(reopened.modelRequests).toBe(0);
    expect(invocations(data.root)).toHaveLength(1);
    expect(readFileSync(data.sentinel, 'utf8')).toBe('Do not read or migrate old user data.\n');
    expect(statSync(data.sentinel).mtimeMs).toBe(data.before.mtimeMs);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}, 30_000);

for (const mode of ['deny', 'partial', 'model-error'] as const) {
  test(`P1 ${mode} does not dispatch the external tool`, async () => {
    const data = await fixture();
    try {
      const evidence = await processEvidence(mode, data.root, data.extensionPath);
      expect(invocations(data.root)).toHaveLength(0);
      const tools = evidence.view.executions.filter((execution) => execution.kind === 'tool');
      expect(tools.every((execution) => execution.status !== 'succeeded')).toBe(true);
      expect(evidence.view.runs).toHaveLength(1);
      expect(evidence.view.runs[0]!.isActive).toBe(false);
      const reopened = await processEvidence('read', data.root, data.extensionPath);
      expectSameFacts(reopened, evidence);
      expect(invocations(data.root)).toHaveLength(0);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  }, 30_000);
}

test('P1 known tool failure is stored without retrying its real side effect', async () => {
  const data = await fixture();
  try {
    const evidence = await processEvidence('fail', data.root, data.extensionPath);
    const tools = evidence.view.executions.filter((execution) => execution.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('failed');
    expect(tools[0]!.result).toMatchObject({ outcome: 'failed', content: 'Known fixture failure' });
    expect(evidence.otherRunStatus).toBe('completed');
    expect(invocations(data.root)).toHaveLength(1);
    const reopened = await processEvidence('read', data.root, data.extensionPath);
    expectSameFacts(reopened, evidence);
    expect(invocations(data.root)).toHaveLength(1);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}, 30_000);

test('P1 no-tool Agent completes conversation without initializing optional capabilities', async () => {
  const data = await fixture();
  try {
    const evidence = await processEvidence('no-tool', data.root, data.extensionPath);
    expect(evidence.view.runs[0]!.status).toBe('completed');
    expect(evidence.view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(
      0,
    );
    expect(evidence.modelRequests).toBe(1);
    expect(evidence.view.messages.some((message) => message.content === 'plain answer')).toBe(true);
    expect(invocations(data.root)).toHaveLength(0);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}, 30_000);

test('Agent root import in a fresh process creates no profile or execution resources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-unified-import-'));
  try {
    const evidence = (await processEvidence('import', root, '')) as unknown as {
      exportedKeys: string[];
    };
    expect(evidence.exportedKeys).toContain('createRuntime');
    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(invocations(root)).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
