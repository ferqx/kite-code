import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { binding } from './run-resume-fixture';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('repeated_resume_timeout');
    await Bun.sleep(5);
  }
}
test('two genuine SIGKILLs during automatic compression retain original Run and effects and retry a fresh summary', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-repeated-resume-')));
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const mode = 'compression_running';
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    for (const phase of ['', '2']) {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL('./run-resume-crash-child.ts', import.meta.url)),
          directory,
          mode,
          ...(phase ? [phase] : []),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      processes.push(child);
      await until(async () =>
        existsSync(join(directory, phase ? `ready-${phase}.json` : 'ready.json')),
      );
      child.kill('SIGKILL');
      await child.exited;
    }
    const first = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
    const second = JSON.parse(readFileSync(join(directory, 'ready-2.json'), 'utf8'));
    expect(second.runId).toBe(first.runId);
    expect(second.executionId).not.toBe(first.executionId);
    store = await openSqliteStore(profile);
    runtime = createRuntime({
      store,
      permissions: binding(directory, mode).permissions!,
      artifacts: createArtifactStore({ profile, store }),
      resolveRecoveryRunConfiguration: async () => binding(directory, mode),
    });
    const input = { ...second, commandId: 'resume-final', sessionId: 's', subjectId: 'owner' };
    const receipt = await runtime.resumeRun(input);
    await until(async () => (await store!.getRun(first.runId))?.status === 'completed');
    expect(await runtime.resumeRun(input)).toEqual(receipt);
    const view = await store.getView('s');
    expect(view.runs).toHaveLength(1);
    for (const interrupted of [first, second])
      expect(await store.getExecution(interrupted.executionId)).toMatchObject({
        status: 'failed',
        result: { incomplete: true },
      });
    expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(1);
    const ledger = readFileSync(join(directory, 'ledger'), 'utf8').trim().split('\n');
    expect(ledger.filter((line) => line.startsWith('effect:'))).toHaveLength(1);
    expect(ledger.filter((line) => line.startsWith('model:'))).toHaveLength(5);
  } finally {
    for (const child of processes) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await runtime?.close();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);

test('replacement of a never-dispatched model survives exits on both sides of the new plan', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-context-reassembly-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const mode = 'planned_context_change';
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    for (const phase of ['', 'retirement', 'replacement']) {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL('./run-resume-crash-child.ts', import.meta.url)),
          directory,
          mode,
          ...(phase ? [phase] : []),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      processes.push(child);
      await until(async () =>
        existsSync(join(directory, phase ? `ready-${phase}.json` : 'ready.json')),
      );
      child.kill('SIGKILL');
      await child.exited;
      expect(child.signalCode).toBe('SIGKILL');
      expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe('');
      if (!phase) writeFileSync(join(directory, 'AGENTS.md'), 'Current project instruction.');
    }
    const ready = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
    const first = ready('ready.json');
    const retired = ready('ready-retirement.json');
    const replacement = ready('ready-replacement.json');
    expect(retired.runId).toBe(first.runId);
    expect(retired.executionId).toBe(first.executionId);
    expect(replacement.runId).toBe(first.runId);
    expect(replacement.executionId).not.toBe(first.executionId);
    store = await openSqliteStore(profile);
    const original = await store.getExecution(first.executionId);
    expect(original).toMatchObject({ status: 'cancelled', modelDispatched: false });
    expect(await store.getExecution(replacement.executionId)).toMatchObject({
      status: 'planned',
      modelDispatched: false,
      decisionSource: { contextRefreshOf: first.executionId },
    });
    runtime = createRuntime({
      store,
      permissions: binding(directory, mode).permissions!,
      artifacts: createArtifactStore({ profile, store }),
      resolveRecoveryRunConfiguration: async () => binding(directory, mode),
    });
    await runtime.resumeRun({
      ...replacement,
      commandId: 'finish-replacement',
      sessionId: 's',
      subjectId: 'owner',
    });
    await until(async () => (await store!.getRun(first.runId))?.status === 'completed');
    expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(
      `model:${replacement.executionId}\n`,
    );
    expect(await store.getExecution(first.executionId)).toEqual(original);
    expect(await store.getExecution(replacement.executionId)).toMatchObject({
      status: 'succeeded',
      modelDispatched: true,
    });
  } finally {
    for (const child of processes) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await runtime?.close();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
