import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createFileTools, createWorkspaceFiles, type FileBaseline } from '../../../../src/files';
import { createWorkspaceSerialLocks } from '../../../../src/resources';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import { presentedFileRead } from '../../../fixtures/presented-file-read';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 7000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= end) throw Error('collaboration_files_deadline');
    await Bun.sleep(5);
  }
}
for (const scenario of ['unselected-content', 'same-content-new-inode'] as const)
  test(`two six-tool children coordinate rereads after actual Files CAS conflict: ${scenario}`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-collaboration-cas-'))),
      profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const files = createWorkspaceFiles({ root: directory }),
      store = await openSqliteStore(profile),
      expectedStoreId = (await store.getMetadata()).storeId;
    writeFileSync(join(directory, 'shared'), 'A=0\nB=0\n');
    const initialStat = statSync(join(directory, 'shared'));
    const bothRead = gate(),
      aWrote = gate();
    let readCount = 0;
    const stages = new Map<string, number>();
    const baselines = new Map<string, FileBaseline>();
    let parentCalls = 0;
    const child: ModelAdapter = {
      async *stream(request) {
        const actor = request.messages.some(
          (message) => message.role === 'user' && message.content === 'Editor A',
        )
          ? 'A'
          : 'B';
        const stage = stages.get(actor) ?? 0;
        stages.set(actor, stage + 1);
        const last = request.messages.filter((message) => message.role === 'tool').at(-1);
        let body: ReturnType<typeof JSON.parse>;
        try {
          body = last ? (presentedFileRead(last.content) ?? JSON.parse(last.content)) : null;
        } catch {
          body = { error: last!.content };
        }
        let events: ModelEvent[];
        if (stage === 0)
          events = call('read_file', { path: 'shared', start_line: 1, max_lines: 1 });
        else if (stage === 1) {
          baselines.set(actor, body.baseline);
          expect(body.content).toBe('A=0\n');
          if (++readCount === 2) bothRead.release();
          await bothRead.promise;
          if (actor === 'B') await aWrote.promise;
          events = call('write_file', {
            path: 'shared',
            base: body.baseline,
            content:
              actor === 'A'
                ? scenario === 'unselected-content'
                  ? 'A=0\nB=1\n'
                  : 'A=0\nB=0\n'
                : 'MUST_NOT_OVERWRITE',
          });
        } else if (actor === 'A') {
          expect(body.baseline).toBeDefined();
          utimesSync(join(directory, 'shared'), initialStat.atime, initialStat.mtime);
          expect(statSync(join(directory, 'shared')).mtime.getTime()).toBe(
            initialStat.mtime.getTime(),
          );
          aWrote.release();
          events = [{ type: 'text_delta', text: 'Editor A publication succeeded.' }, finish];
        } else if (stage === 2) {
          expect(last!.content).toContain('baseline');
          events = call('read_file', { path: 'shared' });
        } else if (stage === 3) {
          expect(body.baseline.inode).not.toBe(baselines.get('B')!.inode);
          if (scenario === 'unselected-content') expect(body.content).toContain('B=1');
          events = call('write_file', {
            path: 'shared',
            base: body.baseline,
            content: scenario === 'unselected-content' ? 'A=1\nB=1\n' : 'A=1\nB=0\n',
          });
        } else {
          expect(body.baseline).toBeDefined();
          events = [
            {
              type: 'text_delta',
              text: 'Editor B reread the actual version and committed a new exact-base invocation.',
            },
            finish,
          ];
        }
        for (const event of events) yield event;
      },
    };
    const task = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'workspace editor' }],
    });
    const fileExtension = {
      id: 'fixture.files',
      version: '1',
      apiMajor: 1 as const,
      tools: createFileTools(files),
    };
    const parent: ModelAdapter = {
      async *stream() {
        if (parentCalls++ === 0) {
          yield {
            type: 'tool_call',
            id: 'A',
            name: 'spawn_agent',
            arguments: JSON.stringify({ prompt: 'Editor A' }),
          };
          yield {
            type: 'tool_call',
            id: 'B',
            name: 'spawn_agent',
            arguments: JSON.stringify({ prompt: 'Editor B' }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield {
            type: 'text_delta',
            text: 'Two editors delegated; no result has been declared complete.',
          };
          yield finish;
        }
      },
    };
    const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
    const runtime = createRuntime({
      workspaceSerialLocks,
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: parent,
      modelId: 'parent',
      modelConcurrency: 3,
      extensions: [task, fileExtension],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'workspace-publication' };
        },
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: fileExtension.tools.map((tool) => tool.id),
          snapshot: { workspace: directory },
        },
      ],
    });
    const identity = { expectedStoreId, subjectId: 'owner', sessionId: 'root' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: pathToFileURL(directory).href,
      });
      await runtime.createSession({
        ...identity,
        commandId: 'create',
        workspaceId: 'w',
        title: 'CAS collaboration',
      });
      const request = { kind: 'run.start' as const, content: 'Coordinate two exact-base editors' };
      await runtime.submitCommand({ ...identity, commandId: 'work', request });
      await runtime.waitForCommand('work', { timeoutMs: 7000 });
      const carriers = await until(async () => {
        const values = (await store.listExecutions('root')).filter(
          (execution) => execution.childSessionId,
        );
        return values.length === 2 && values.every((value) => value.status === 'succeeded')
          ? values
          : undefined;
      });
      const executions = (
        await Promise.all(carriers.map((carrier) => store.listExecutions(carrier.childSessionId!)))
      ).flat();
      const conflicts = executions.filter(
        (execution) => execution.definitionId === 'files.write' && execution.status === 'failed',
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.result).toMatchObject({
        outcome: 'failed',
        details: { code: 'file_baseline_conflict' },
      });
      expect(
        executions.filter(
          (execution) =>
            execution.definitionId === 'files.write' && execution.status === 'succeeded',
        ),
      ).toHaveLength(2);
      expect(executions.some((execution) => execution.status === 'outcome_unknown')).toBe(false);
      expect(readFileSync(join(directory, 'shared'), 'utf8')).toBe(
        scenario === 'unselected-content' ? 'A=1\nB=1\n' : 'A=1\nB=0\n',
      );
      const count = parentCalls;
      const stats = statSync(join(directory, 'shared'));
      await runtime.submitCommand({ ...identity, commandId: 'work', request });
      expect(parentCalls).toBe(count);
      expect(statSync(join(directory, 'shared')).ino).toBe(stats.ino);
    } finally {
      bothRead.release();
      aWrote.release();
      await runtime.close();
      await workspaceSerialLocks.close();
      await store.close();
      await files.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);

for (const unknown of [false, true])
  test(`six-tool child preserves first-file success and ${unknown ? 'published second-file unknown without replay' : 'second-file external CAS conflict without fictional batch rollback'}`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-collaboration-partial-'))),
      profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const files = createWorkspaceFiles({ root: directory });
    const store = await openSqliteStore(profile),
      expectedStoreId = (await store.getMetadata()).storeId;
    writeFileSync(join(directory, 'X'), 'X=old');
    writeFileSync(join(directory, 'Y'), 'Y=old');
    let afterPublications = 0,
      childCalls = 0,
      parentCalls = 0;
    const bases = new Map<string, FileBaseline>();
    const tools = createFileTools(files, {
      capture: {
        async before(input) {
          return input.path;
        },
        async after(token) {
          afterPublications++;
          if (unknown && token === 'Y')
            throw Error('isolated confirmation failure after actual Y publication');
        },
        async failed() {},
      },
    });
    const task = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'workspace editor' }],
    });
    const child: ModelAdapter = {
      async *stream(request) {
        const stage = childCalls++;
        const messages = request.messages.filter((message) => message.role === 'tool');
        let body: ReturnType<typeof JSON.parse>;
        try {
          body = messages.length
            ? (presentedFileRead(messages.at(-1)!.content) ?? JSON.parse(messages.at(-1)!.content))
            : null;
        } catch {
          body = { error: messages.at(-1)!.content };
        }
        let events: ModelEvent[];
        if (stage === 0) {
          yield {
            type: 'tool_call',
            id: 'read-X',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'X' }),
          };
          yield {
            type: 'tool_call',
            id: 'read-Y',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'Y' }),
          };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (stage === 1) {
          for (const message of messages) {
            const read = presentedFileRead(message.content);
            expect(read).toBeDefined();
            if (read!.path === 'X' || read!.path === 'Y') bases.set(read!.path, read!.baseline);
          }
          events = call('write_file', { path: 'X', base: bases.get('X'), content: 'X=committed' });
        } else if (stage === 2) {
          expect(body.baseline).toBeDefined();
          expect(readFileSync(join(directory, 'X'), 'utf8')).toBe('X=committed');
          if (!unknown) writeFileSync(join(directory, 'Y'), 'Y=external-direct-write');
          events = call('write_file', { path: 'Y', base: bases.get('Y'), content: 'Y=published' });
        } else {
          expect(unknown).toBe(false);
          events = [
            {
              type: 'text_delta',
              text: 'PARTIAL BUSINESS RESULT: X committed; Y rejected with an exact baseline conflict. No batch rollback or compensation occurred.',
            },
            finish,
          ];
        }
        for (const event of events) yield event;
      },
    };
    const parent: ModelAdapter = {
      async *stream() {
        if (parentCalls++ === 0)
          for (const event of call('spawn_agent', {
            prompt: 'Modify X then Y and report each exact outcome separately.',
          }))
            yield event;
        else {
          yield {
            type: 'text_delta',
            text: 'Delegated two-file work; no atomic batch completion is claimed.',
          };
          yield finish;
        }
      },
    };
    const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
    const runtime = createRuntime({
      workspaceSerialLocks,
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: parent,
      modelId: 'parent',
      modelConcurrency: 2,
      extensions: [task, { id: 'fixture.files', version: '1', apiMajor: 1 as const, tools }],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'current' };
        },
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: tools.map((tool) => tool.id),
          snapshot: { workspace: directory },
        },
      ],
    });
    const identity = { expectedStoreId, subjectId: 'owner', sessionId: 'root' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: pathToFileURL(directory).href,
      });
      await runtime.createSession({
        ...identity,
        commandId: 'create',
        workspaceId: 'w',
        title: 'partial outcomes',
      });
      const request = {
        kind: 'run.start' as const,
        content: 'Perform separately scoped file changes',
      };
      await runtime.submitCommand({ ...identity, commandId: 'work', request });
      await runtime.waitForCommand('work', { timeoutMs: 7000 });
      const carrier = await until(async () =>
        (await store.listExecutions('root')).find((execution) => execution.childSessionId),
      );
      const result = await until(async () =>
        (await store.listExecutions(carrier.childSessionId!)).find(
          (execution) =>
            execution.definitionId === 'files.write' &&
            ['failed', 'outcome_unknown'].includes(execution.status),
        ),
      );
      expect(result.result).toMatchObject({
        outcome: unknown ? 'outcome_unknown' : 'failed',
        details: { code: unknown ? 'file_publish_outcome_unknown' : 'file_baseline_conflict' },
      });
      expect(readFileSync(join(directory, 'X'), 'utf8')).toBe('X=committed');
      expect(readFileSync(join(directory, 'Y'), 'utf8')).toBe(
        unknown ? 'Y=published' : 'Y=external-direct-write',
      );
      expect(afterPublications).toBe(unknown ? 2 : 1);
      const calls = childCalls;
      await runtime.submitCommand({ ...identity, commandId: 'work', request });
      const verified = await files.read('Y');
      expect(verified.content).toBe(unknown ? 'Y=published' : 'Y=external-direct-write');
      expect(afterPublications).toBe(unknown ? 2 : 1);
      expect(childCalls).toBe(calls);
      if (unknown) {
        expect((await store.getExecution(result.id))!.status).toBe('outcome_unknown');
        expect(childCalls).toBe(3);
      } else
        await until(async () =>
          (await store.getExecution(carrier.id))?.status === 'succeeded' ? true : undefined,
        );
    } finally {
      await runtime.close();
      await workspaceSerialLocks.close();
      await store.close();
      await files.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
