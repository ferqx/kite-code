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

for (const boundary of ['response', 'results', 'skill_and_write'])
  test(`real SIGKILL ${boundary} verifies read admission at the original decision boundary`, async () => {
    const withSkill = boundary === 'skill_and_write';
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-discovery-resume-')));
    for (const name of ['', 'apps', 'packages', 'docs'])
      mkdirSync(join(directory, 'workspace', name), { recursive: true });
    writeFileSync(join(directory, 'workspace', 'AGENTS.md'), 'Original root rule.');
    writeFileSync(join(directory, 'workspace', 'docs/AGENTS.md'), 'Original local docs rule.');
    writeFileSync(join(directory, 'workspace', 'package.json'), '{"name":"actual-discovery"}');
    if (withSkill) writeFileSync(join(directory, 'workspace', 'SKILL.md'), 'Verified Skill text.');
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
      if (withSkill) writeFileSync(join(directory, 'workspace', 'AGENTS.md'), 'Fresh root rule.');
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      store = await openSqliteStore(profile);
      const before = await store.listExecutions('s');
      expect(before.filter((item) => item.kind === 'tool')).toHaveLength(
        boundary === 'results' ? 4 : 0,
      );
      expect(before.find((item) => item.id === ready.executionId)?.status).toBe(
        boundary === 'results' ? 'planned' : 'succeeded',
      );
      fixture = discoveryBinding(directory, withSkill);
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
      if (withSkill) {
        expect(tools).toHaveLength(2);
        expect(tools.find(({ callId }) => callId === 'skill')).toMatchObject({
          status: 'succeeded',
          authorization: { dispatched: true },
          decisionSource: { modelExecutionId: ready.executionId },
        });
        expect(tools.find(({ callId }) => callId === 'write')).toMatchObject({
          status: 'failed',
          authorization: { dispatched: false },
          result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
        });
        expect(readFileSync(join(directory, 'io.jsonl'), 'utf8')).toBe('');
        expect(existsSync(join(directory, 'workspace', 'stale.txt'))).toBe(false);
        const models = readFileSync(join(directory, 'models.jsonl'), 'utf8').trim().split('\n');
        expect(models).toHaveLength(2);
        expect(models[1]).toContain('Fresh root rule.');
        expect(models[1]).toContain('Verified Skill text.');
        return;
      }
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
        'apps/app-evidence.txt',
        'docs/AGENTS.md',
        'package.json',
        'packages/package-evidence.txt',
      ]);
      expect(io.every((item) => item.name === 'files.read')).toBe(true);
      expect(new Set(io.map((item) => item.path)).size).toBe(4);
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
