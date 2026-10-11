import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import {
  observeOwnedProcessIdentity,
  ownedProcessKernelState,
} from '@kite-ai/agent/process-observation';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';

async function waitForFile(path: string) {
  const deadline = Date.now() + 2000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('synchronous_fixture_entry_unconfirmed');
    await Bun.sleep(5);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('a trusted synchronous callback blocks its own timer and observation; an independent host works and cold reads never replay it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-synchronous-boundary-')));
  let child: ReturnType<typeof Bun.spawn> | undefined,
    stdout: Promise<string> | undefined,
    stderr: Promise<string> | undefined;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    healthy: ReturnType<typeof createRuntime> | undefined;
  try {
    const started = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, '../../fixtures/unified-agent/synchronous-extension.ts'),
        root,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    child = started;
    stdout = new Response(started.stdout).text();
    stderr = new Response(started.stderr).text();
    const ready = (await waitForFile(join(root, 'ready.json'))) as {
      pid: number;
      expectedStoreId: string;
    };
    const entered = (await waitForFile(join(root, 'entered.json'))) as {
      pid: number;
      executionId: string;
      modelRequests: number;
      enteredAt: number;
      timeoutMs: number;
    };
    expect(ready.pid).toBe(child.pid);
    expect(entered.pid).toBe(child.pid);
    expect(entered.modelRequests).toBe(1);
    const original = observeOwnedProcessIdentity(child.pid);
    if (process.platform === 'darwin') {
      expect(original.birth).not.toBeNull();
      expect(original.parentPid).toBe(process.pid);
      expect(original.unavailable).toEqual([]);
      expect(ownedProcessKernelState(original)).toBe('alive');
    }

    const model = createFixedModel([
      [
        { type: 'text_delta', text: 'independent ordinary task completed' },
        { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    healthy = createRuntime({
      store: await openSqliteStore({ dataRoot: join(root, 'independent'), profile: 'test' }),
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    const expectedStoreId = (await healthy.getMetadata()).storeId;
    await healthy.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Independent',
      rootUri: pathToFileURL(root).href,
    });
    await healthy.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      subjectId: 'owner',
      workspaceId: 'w',
      title: 'Independent host',
    });
    await healthy.submitCommand({
      expectedStoreId,
      commandId: 'healthy',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'An independent ordinary task.' },
    });
    await healthy.waitForCommand('healthy');
    const view = await healthy.getView('s');
    expect(view.runs[0]!.status).toBe('completed');
    expect(
      view.messages.some((message) => message.content === 'independent ordinary task completed'),
    ).toBe(true);
    expect(model.requests).toHaveLength(1);
    await healthy.close();
    healthy = undefined;

    const remaining = entered.enteredAt + entered.timeoutMs + 100 - Date.now();
    if (remaining > 0) await Bun.sleep(remaining);
    expect(Date.now() - entered.enteredAt).toBeGreaterThan(entered.timeoutMs);
    expect(child.exitCode).toBeNull();
    expect(existsSync(join(root, 'timer-fired.json'))).toBe(false);
    expect(existsSync(join(root, 'observation-returned.json'))).toBe(false);
    if (process.platform === 'darwin') expect(ownedProcessKernelState(original)).toBe('alive');
    // Only the retained child handle ends the deliberate blocked fixture. This is forced exit,
    // never a successful Runtime cancel, graceful shutdown or full descendant census.
    child.kill('SIGKILL');
    expect(await child.exited).not.toBe(0);
    expect(await stdout).toBe('');
    expect(await stderr).toBe('');
    if (process.platform === 'darwin') expect(ownedProcessKernelState(original)).toBe('absent');

    reader = await openSqliteStore({
      dataRoot: join(root, 'data'),
      profile: 'test',
      mode: 'readonly',
    });
    const before = await reader.getView('s'),
      command = await reader.getCommand('work'),
      metadata = await reader.getMetadata();
    expect(metadata.storeId).toBe(ready.expectedStoreId);
    expect(command!.status).toBe('applied');
    expect(before.runs[0]!.status).toBe('running');
    expect(
      before.executions.find((execution) => execution.id === entered.executionId),
    ).toMatchObject({
      kind: 'tool',
      definitionId: 'fixture.synchronous',
      status: 'dispatching',
      result: null,
    });
    const coldModel = createFixedModel([]);
    const cold = createRuntime({
      store: reader,
      model: coldModel,
      modelId: 'cold',
      permissions: {
        async authorize() {
          throw new Error('Cold history must never request execution permission.');
        },
      },
    });
    reader = undefined;
    try {
      expect(await cold.getView('s')).toEqual(before);
      expect(await cold.getCommand('work')).toEqual(command);
      expect(await cold.getMetadata()).toEqual(metadata);
      expect(coldModel.requests).toHaveLength(0);
      expect(existsSync(join(root, 'timer-fired.json'))).toBe(false);
      expect(existsSync(join(root, 'observation-returned.json'))).toBe(false);
    } finally {
      await cold.close();
    }
  } finally {
    if (child) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await Promise.all([stdout, stderr]);
    }
    await healthy?.close();
    await reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
