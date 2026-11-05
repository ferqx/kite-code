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
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import type { FileCheckpointRecord } from '@kite-ai/agent/files';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { taskQualityPresentedRead } from '../../../../tests/e2e/live/model/agent-task-quality-fixture';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

type Body = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string; description: string; parameters: unknown } }[];
};
type Paths = { root: string; workspace: string; target: string; privateTarget: string };
type Call = { name: string; input: Json };
type Program = (body: Body, step: number, actor: 'root' | 'child', paths: Paths) => Call | null;

async function fixture(options: {
  mode?: 'full' | 'accept_edits' | 'auto';
  beforeDispatch?: 'demote' | 'untrust';
  program: Program;
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-full-external-files-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'test' });
  privateDirectory(profile.profilePath);
  const paths = {
    root,
    workspace,
    target: join(root, 'external', 'missing-parent', 'report.txt'),
    privateTarget: join(profile.profilePath, 'must-not-create.txt'),
  };
  const requests: Body[] = [];
  const steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Body;
      requests.push(body);
      const actor = body.messages.some(
        (message) => message.role === 'user' && message.content.startsWith('CHILD_'),
      )
        ? 'child'
        : 'root';
      const step = steps.get(actor) ?? 0;
      steps.set(actor, step + 1);
      const call = options.program(body, step, actor, paths);
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `full-files-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        `${frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${actor}-${step}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'Controlled file journey finished.' },
          null,
        )}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    configurationPath,
    JSON.stringify({
      modelId: 'fixed',
      models: [
        {
          id: 'fixed',
          provider: 'compatible',
          model: 'fixed',
          baseURL: `${provider.url.href}v1`,
        },
      ],
      tools: [
        'files.read',
        'files.write',
        'files.edit',
        'task.spawn',
        'task.events',
        'task.list',
      ].map((id) => ({ id })),
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: configurationPath,
    localCodex: false,
    credentialBackend: createTemporaryCredentialBackend(),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const storeId = (await store.getMetadata()).storeId;
  const artifacts = createArtifactStore({ profile, store });
  const locks = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks?.(locks);
  let changedBeforeDispatch = false;
  let management: ReturnType<NonNullable<typeof host.permissionManagement>>;
  const observedStore = new Proxy(store, {
    get(target, property) {
      if (property !== 'markDispatching') return Reflect.get(target, property);
      return async (input: Parameters<typeof store.markDispatching>[0]) => {
        const actual = await store.getExecution(input.executionId);
        if (
          options.beforeDispatch &&
          !changedBeforeDispatch &&
          actual?.definitionId === 'files.write' &&
          (actual.input as { path?: string }).path === paths.target
        ) {
          changedBeforeDispatch = true;
          if (options.beforeDispatch === 'demote') {
            const mode = await management.readMode({
              expectedStoreId: storeId,
              subjectId: 'owner',
              sessionId: 's',
            });
            await management.setMode({
              expectedStoreId: storeId,
              subjectId: 'owner',
              commandId: 'demote-before-publish',
              sessionId: 's',
              mode: 'accept_edits',
              makeDefault: false,
              ifRevision: mode.revision,
              ifDefaultRevision: mode.defaultRevision,
            });
          } else {
            const trust = await management.readTrust({
              expectedStoreId: storeId,
              subjectId: 'owner',
              workspaceId: 'w',
            });
            await management.setTrust({
              expectedStoreId: storeId,
              subjectId: 'owner',
              commandId: 'untrust-before-publish',
              workspaceId: 'w',
              trusted: false,
              ifRevision: trust.revision,
              canonicalIdentity: trust.canonicalIdentity,
              externalReadScopeDigest: trust.externalReadScopeDigest,
            });
          }
        }
        return store.markDispatching(input);
      };
    },
  });
  const runtime = createRuntime({
    ...host,
    store: observedStore,
    artifacts,
    workspaceSerialLocks: locks,
    permissions: host.permissions!,
  });
  management = host.permissionManagement!(runtime);
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'Owned external files',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Full external file operations',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    expectedStoreId: storeId,
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    mode: options.mode ?? 'full',
    trusted: true,
  });
  return {
    ...paths,
    runtime,
    store,
    storeId,
    configurationPath,
    requests,
    changed: () => changedBeforeDispatch,
    async run() {
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: {
          kind: 'run.start',
          content: 'FULL_FILE_JOURNEY: operate only owned test targets.',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
    },
    async close() {
      await runtime.close();
      await locks.close();
      await artifacts.close();
      await store.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const mode of ['accept_edits', 'auto', 'full'] as const) {
  test(`${mode} ordinary missing reads reach the next Model as observations with the final unified Files catalogue`, async () => {
    const f = await fixture({
      mode,
      program: (_body, step, _actor, paths) =>
        step < 2
          ? {
              name: 'read_file',
              input: { path: step === 0 ? 'missing-workspace.txt' : paths.target },
            }
          : null,
    });
    try {
      await f.run();
      const reads = (await f.store.listExecutions('s')).filter(
        (row) => row.definitionId === 'files.read',
      );
      expect(reads).toHaveLength(2);
      for (const [index, row] of reads.entries()) {
        const path = index === 0 ? 'missing-workspace.txt' : f.target;
        expect(row.status).toBe('succeeded');
        expect(row.authorization?.dispatched).toBe(true);
        expect(row.authorization?.check).toBeUndefined();
        expect(row.authorization?.human).toBeUndefined();
        expect(row.result).toEqual({
          outcome: 'succeeded',
          content: `File does not exist: ${JSON.stringify(path)}.`,
          details: { path, exists: false },
        });
        expect(
          f.requests[index + 1]!.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.content === `File does not exist: ${JSON.stringify(path)}.`,
          ),
        ).toBe(true);
      }
      for (const name of ['read_file', 'write_file', 'edit_file']) {
        const tool = f.requests[0]!.tools.find((value) => value.function.name === name)!.function;
        expect(tool.description).toContain(
          'Only effective Full access supports direct ordinary external writes and edits',
        );
        expect(tool.description).toContain('do not open an approval card');
        expect(tool.description).not.toContain('external reads are read-only and have no baseline');
        const properties = (
          tool.parameters as { properties: Record<string, { description?: string }> }
        ).properties;
        expect(properties.path!.description).toContain('including ordinary external files');
        expect(properties.filesystem).toBeUndefined();
        expect(properties.network).toBeUndefined();
      }
      expect(existsSync(f.target)).toBe(false);
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20000);
}

test('Full actual Service writes and edits an external file with native baselines and immutable Artifacts without checkpointing it', async () => {
  const first = 'before external 😀\r\n';
  const edited = 'after external 😀\r\n';
  const f = await fixture({
    program(body, step, _actor, paths): Call | null {
      if (step === 0)
        return { name: 'write_file', input: { path: paths.target, base: null, content: first } };
      if (step === 1 || step === 3) return { name: 'read_file', input: { path: paths.target } };
      if (step === 2) {
        const feedback = body.messages.filter((message) => message.role === 'tool').at(-1)!;
        const externalNotice =
          'External file; outside workspace checkpoints. Baseline does not grant write permission.\n';
        expect(feedback.content).toContain(externalNotice);
        const actual = taskQualityPresentedRead(feedback.content.replace(externalNotice, ''));
        expect(actual?.path).toBe(paths.target);
        return {
          name: 'edit_file',
          input: {
            path: paths.target,
            base: actual!.baseline,
            old_text: 'before',
            new_text: 'after',
            expected_matches: 1,
          },
        };
      }
      return step === 4
        ? {
            name: 'write_file',
            input: { path: 'local.txt', base: null, content: 'local checkpoint control' },
          }
        : null;
    },
  });
  try {
    await f.run();
    expect(readFileSync(f.target, 'utf8')).toBe(edited);
    const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
    expect(tools.map((e) => [e.definitionId, e.status])).toEqual([
      ['files.write', 'succeeded'],
      ['files.read', 'succeeded'],
      ['files.edit', 'succeeded'],
      ['files.read', 'succeeded'],
      ['files.write', 'succeeded'],
    ]);
    expect(
      tools.every(
        (e) => e.authorization?.dispatched && !e.authorization.check && !e.authorization.human,
      ),
    ).toBe(true);
    for (const [execution, bytes] of [
      [tools[0]!, first],
      [tools[2]!, edited],
    ] as const) {
      const result = execution.result as {
        content: string;
        artifactRefs: { id: string; scope: { kind: 'execution'; id: string } }[];
      };
      const original = JSON.parse(result.content);
      expect(original.path).toBe(f.target);
      expect(original.baseline.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.artifactRefs).toHaveLength(1);
      const ref = result.artifactRefs[0]!;
      const artifact = await f.runtime.readArtifact({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        refId: ref.id,
        scope: ref.scope,
      });
      expect(Buffer.from(artifact.content).toString('utf8')).toBe(bytes);
    }
    const records = await f.store.listExtensionRecords({
      sessionId: 's',
      extensionId: 'builtin.files',
      limit: 200,
    });
    const capturedPaths = records
      .filter((r) => r.contentType === 'builtin.files.checkpoint.file')
      .map((r) => (r.value as unknown as FileCheckpointRecord).path);
    expect(capturedPaths).toEqual(['local.txt']);
    expect(
      await f.runtime.listInteractions({
        expectedStoreId: f.storeId,
        sessionId: 's',
        state: 'pending',
      }),
    ).toMatchObject({ interactions: [] });
  } finally {
    await f.close();
  }
}, 20000);

for (const mode of ['accept_edits', 'auto'] as const) {
  test(`${mode} keeps external Files writes outside the tool's scope without starting an approval`, async () => {
    const f = await fixture({
      mode,
      program: (_body, step, _actor, paths) =>
        step === 0
          ? {
              name: 'write_file',
              input: { path: paths.target, base: null, content: 'must not publish' },
            }
          : null,
    });
    try {
      await f.run();
      expect(existsSync(f.target)).toBe(false);
      const tool = (await f.store.listExecutions('s')).find(
        (e) => e.definitionId === 'files.write',
      )!;
      expect(tool.status).toBe('failed');
      expect(tool).toMatchObject({
        sessionId: 's',
        originStoreId: f.storeId,
        definitionVersion: '3',
        input: { path: f.target, base: null, content: 'must not publish' },
      });
      expect(tool.authorization?.dispatched).toBe(false);
      expect(tool.result).toMatchObject({
        details: {
          code: 'permission_denied',
          reason: 'file_full_access_required',
          adapterAttempted: false,
          dispatchCommitted: false,
        },
      });
      const explanation = 'This is a limitation of this tool entry';
      expect((tool.result as { content: string }).content).toContain(explanation);
      expect((tool.result as { content: string }).content).toContain(
        'not approval for another tool',
      );
      expect((tool.result as { content: string }).content).toContain(
        'under its existing approval rules',
      );
      const nextFeedback = f.requests[1]!.messages.filter((message) => message.role === 'tool');
      expect(nextFeedback).toHaveLength(1);
      expect(nextFeedback[0]).toMatchObject({ tool_call_id: tool.callId });
      const nextModel = (await f.store.listExecutions('s'))
        .filter((execution) => execution.kind === 'model' && execution.runId === tool.runId)
        .at(-1)!;
      const canonical = await f.runtime.readModelInput({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        executionId: nextModel.id,
      });
      expect(
        canonical.request.messages.find((message) => message.toolCallId === tool.callId),
      ).toMatchObject({
        toolCallId: tool.callId,
        sourceIds: [tool.id],
        content: nextFeedback[0]!.content,
      });
      expect(nextFeedback[0]!.content).toContain('requires Full mode');
      expect(nextFeedback[0]!.content).toContain('This request did not change the file');
      expect(nextFeedback[0]!.content).toContain('not a user rejection of the task');
      expect(nextFeedback[0]!.content).toContain(
        'A separately authorized request may use an available tool within its own permissions',
      );
      expect(nextFeedback[0]!.content).toContain(
        'unless an earlier refusal or unknown result prevents it',
      );
      expect(tool.authorization?.check).toBeUndefined();
      expect(tool.authorization?.human).toBeUndefined();
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20000);
}

test('Full external file support keeps the private Profile protected', async () => {
  const f = await fixture({
    program: (_body, step, _actor, paths) =>
      step === 0
        ? {
            name: 'write_file',
            input: { path: paths.privateTarget, base: null, content: 'must not publish' },
          }
        : null,
  });
  const originalConfiguration = readFileSync(f.configurationPath);
  try {
    await f.run();
    expect(existsSync(f.privateTarget)).toBe(false);
    expect(readFileSync(f.configurationPath)).toEqual(originalConfiguration);
    const tool = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'files.write')!;
    expect(tool.status).toBe('failed');
    expect(tool.result).toMatchObject({
      details: {
        code: 'permission_denied',
        reason: 'input_file_read_only',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    });
    expect((tool.result as { content: string }).content).toContain('input_file_read_only');
    expect(
      (
        await f.runtime.listInteractions({
          expectedStoreId: f.storeId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions,
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);

for (const change of ['demote', 'untrust'] as const) {
  test(`Full external file publication rechecks durable ${change} before dispatch`, async () => {
    const f = await fixture({
      beforeDispatch: change,
      program: (_body, step, _actor, paths) =>
        step === 0
          ? {
              name: 'write_file',
              input: { path: paths.target, base: null, content: 'must not publish' },
            }
          : null,
    });
    try {
      await f.run();
      expect(f.changed()).toBe(true);
      expect(existsSync(f.target)).toBe(false);
      const tool = (await f.store.listExecutions('s')).find(
        (e) => e.definitionId === 'files.write',
      )!;
      expect(tool.status).not.toBe('succeeded');
      expect(tool.authorization?.dispatched).not.toBe(true);
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20000);
}

for (const preset of ['code', 'explore'] as const) {
  test(`Full child ${preset} preserves the selected file tool boundary`, async () => {
    const f = await fixture({
      program: (_body, step, actor, paths): Call | null =>
        actor === 'root'
          ? step === 0
            ? {
                name: 'spawn_agent',
                input: {
                  preset,
                  prompt: `CHILD_WRITE_ONLY: write ${paths.target} with the exact content child`,
                },
              }
            : null
          : step === 0
            ? { name: 'write_file', input: { path: paths.target, base: null, content: 'child' } }
            : null,
    });
    try {
      await f.run();
      const deadline = Date.now() + 8000;
      let carrier = (await f.store.listExecutions('s')).find(
        (e) => e.kind === 'job' && e.childSessionId,
      );
      while (
        !carrier ||
        !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(carrier.status)
      ) {
        if (Date.now() > deadline) throw new Error('full_external_child_deadline');
        await Bun.sleep(5);
        carrier = (await f.store.listExecutions('s')).find(
          (e) => e.kind === 'job' && e.childSessionId,
        );
      }
      const child = (await f.store.listExecutions(carrier.childSessionId!)).filter(
        (e) => e.kind === 'tool',
      );
      const childRequests = f.requests.filter((body) =>
        body.messages.some((m) => m.role === 'user' && m.content.startsWith('CHILD_')),
      );
      expect(childRequests.length).toBeGreaterThan(0);
      expect(childRequests[0]!.tools.some((tool) => tool.function.name === 'write_file')).toBe(
        preset === 'code',
      );
      if (preset === 'code') {
        expect(readFileSync(f.target, 'utf8')).toBe('child');
        expect(child.find((e) => e.definitionId === 'files.write')?.status).toBe('succeeded');
      } else {
        expect(existsSync(f.target)).toBe(false);
        expect(child.every((e) => e.status !== 'succeeded')).toBe(true);
      }
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20000);
}
