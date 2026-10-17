import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { discoveryBinding } from './source-discovery-resume-child';

for (const boundary of ['response', 'results'])
  test(`real SIGKILL ${boundary} resumes mixed readonly discovery without duplicated IO or refresh failures`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-discovery-resume-')));
    for (const name of ['', 'apps', 'packages', 'docs'])
      mkdirSync(join(directory, 'workspace', name), { recursive: true });
    writeFileSync(join(directory, 'workspace', 'AGENTS.md'), 'Original root rule.');
    writeFileSync(join(directory, 'workspace', 'docs/AGENTS.md'), 'Original local docs rule.');
    writeFileSync(join(directory, 'workspace', 'package.json'), '{"name":"actual-discovery"}');
    writeFileSync(join(directory, 'workspace', 'apps/app-evidence.txt'), 'apps evidence');
    writeFileSync(
      join(directory, 'workspace', 'packages/package-evidence.txt'),
      'packages evidence',
    );
    writeFileSync(join(directory, 'io.jsonl'), '');
    writeFileSync(join(directory, 'models.jsonl'), '');
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./source-discovery-resume-child.ts', import.meta.url)),
        directory,
        boundary,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let fixture: ReturnType<typeof discoveryBinding> | undefined;
    try {
      const deadline = Date.now() + 7000;
      while (!existsSync(join(directory, 'ready.json'))) {
        if (Date.now() > deadline) throw Error('discovery_child_boundary_timeout');
        await Bun.sleep(5);
      }
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
      child.kill('SIGKILL');
      expect(await child.exited).not.toBe(0);
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      store = await openSqliteStore(profile);
      const before = await store.listExecutions('s');
      expect(before.filter((item) => item.kind === 'tool')).toHaveLength(
        boundary === 'response' ? 0 : 4,
      );
      expect(before.find((item) => item.id === ready.executionId)?.status).toBe(
        boundary === 'response' ? 'succeeded' : 'planned',
      );
      fixture = discoveryBinding(directory);
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        permissions: fixture.configuration.permissions!,
        resolveRecoveryRunConfiguration: async () => fixture!.configuration,
      });
      await runtime.resumeRun({
        ...ready,
        commandId: 'resume',
        subjectId: 'owner',
        sessionId: 's',
      });
      await runtime.waitForCommand('resume', { timeoutMs: 5000 });
      expect(await store.getRun(ready.runId)).toMatchObject({
        status: 'completed',
        isActive: false,
      });
      expect((await store.getView('s')).runs).toHaveLength(1);
      const tools = (await store.listExecutions('s')).filter((item) => item.kind === 'tool');
      expect(tools).toHaveLength(4);
      expect(
        tools.every(
          (item) => item.status === 'succeeded' && item.authorization?.dispatched === true,
        ),
      ).toBe(true);
      const io = readFileSync(join(directory, 'io.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(io.map((item) => item.path).sort()).toEqual([
        'apps',
        'docs',
        'package.json',
        'packages',
      ]);
      const models = readFileSync(join(directory, 'models.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ModelRequest);
      expect(models).toHaveLength(2);
      expect(JSON.stringify(models[0]!.messages)).not.toContain('Original local docs rule.');
      const next = models[1]!;
      expect(JSON.stringify(next.messages)).toContain('Original local docs rule.');
      expect(JSON.stringify(next.messages)).not.toContain('context_refresh_required');
      expect(
        next.messages
          .filter((item) => item.role === 'tool')
          .map((item) => item.toolCallId)
          .sort(),
      ).toEqual(['apps', 'docs', 'package', 'packages']);
      expect(JSON.stringify(next.messages)).toContain('actual-discovery');
      for (const [callId, evidence] of [
        ['package', 'actual-discovery'],
        ['apps', 'app-evidence.txt'],
        ['packages', 'package-evidence.txt'],
        ['docs', 'AGENTS.md'],
      ]) {
        const message = next.messages.find((item) => item.toolCallId === callId)!;
        expect(message.content).toContain(evidence!);
        expect(message.sourceIds).toContain(tools.find((item) => item.callId === callId)!.id);
      }
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      await runtime?.close();
      await fixture?.close();
      await store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
