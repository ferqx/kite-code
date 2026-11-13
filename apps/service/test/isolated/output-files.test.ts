import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AgentRuntime,
  createRuntime,
  prepareOutputDirectory,
  withOutputCollection,
} from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { JobDefinition, JobHandle } from '@kite-ai/agent/extensions';
import { createWorkingInputFiles } from '@kite-ai/agent/files';
import { createShellExtension } from '@kite-ai/agent/shell';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { AgentClient } from '@kite-ai/client';
import { launchIdentityAsync } from '../../../../packages/agent/src/jobs/launch-identity';
import { startService } from '../../src';

test('real HTTP output stream and input preparation preserve exact source and edited work after ACK', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-office-http-'));
  const profile = { dataRoot: join(root, 'profile'), profile: 'test' },
    store = await openSqliteStore(profile),
    paths = resolveProfile(profile);
  let runtime!: AgentRuntime;
  const tasks = new WeakMap<JobHandle, Promise<number>>();
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Real process integration',
    inputSchema: { type: 'object' },
    async start(input, context) {
      const directory = await mkdtemp(join(root, 'producer-'));
      const allocation = await runtime.prepareOutputCollection(
        context,
        await launchIdentityAsync(directory),
      );
      const handle = { reference: {} };
      tasks.set(
        handle,
        new Promise((resolve, reject) => {
          const process = spawn('/bin/bash', ['-c', (input as { command: string }).command], {
            env: { ...globalThis.process.env, ...allocation.env },
            stdio: 'ignore',
          });
          process.once('error', reject);
          process.once('exit', (code) => resolve(code ?? 1));
        }),
      );
      return handle;
    },
    async *observe(handle) {
      const code = await tasks.get(handle);
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: code === 0 ? 'succeeded' : 'failed',
          content: 'created',
          details: { exitCode: code ?? 1, processTreeStopped: true },
        },
      };
    },
    async cancel() {
      return { status: 'unknown' };
    },
    async dispose() {},
  };
  const finish = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  } as const;
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        name: 'shell_execute',
        id: 'create',
        arguments: JSON.stringify({
          command: 'printf "original report" > "$KITE_OUTPUT_DIR/报告.txt"',
        }),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Done' }, finish],
    [{ type: 'text_delta', text: 'Ready to edit' }, finish],
  ]);
  runtime = createRuntime({
    store,
    outputCollections: {
      prepare: (context, identity) => prepareOutputDirectory(runtime, context, identity),
    },
    model,
    modelId: 'fixed',
    artifacts: createArtifactStore({ store, profile }),
    workingInputFiles: createWorkingInputFiles(),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
    extensions: [
      createShellExtension({ job }),
      withOutputCollection({ id: 'builtin.files', version: '1', apiMajor: 1 }, () => runtime),
    ],
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: paths.profileAccessKey,
    },
    buildId: 'fixture',
    subjectId: 'owner',
  });
  const client = new AgentClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: paths.profileAccessKey,
      },
      apiMajor: 1,
      requiredCapabilities: ['commands', 'output_files'],
    },
  });
  try {
    await client.connect();
    const storeId = (await store.getMetadata()).storeId,
      base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'working',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create-session',
      workspaceId: 'w',
      title: 'office',
    });
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'generate',
      kind: 'run.start',
      content: 'Create a file',
    });
    let page = await client.queryOutputFiles({ scope: { storeId, sessionId: 's' } });
    for (let i = 0; i < 500 && !page.items.length; i++) {
      await Bun.sleep(10);
      page = await client.queryOutputFiles({ scope: { storeId, sessionId: 's' } });
    }
    expect(page.items).toHaveLength(1);
    const target = page.items[0]!;
    const resolved = await client.resolveOutputFile(target);
    expect(resolved.summary.name).toBe('报告.txt');
    const stream = await client.readOutputFileStream(target);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of stream.content) {
        bytes += chunk.byteLength;
        hash.update(chunk);
      }
    } finally {
      await stream.cancel();
    }
    expect(String(bytes)).toBe(resolved.reference.size);
    expect(hash.digest('hex')).toBe(resolved.reference.hash);
    expect(model.requests).toHaveLength(2);
    const interrupted = await client.readOutputFileStream(target);
    for await (const chunk of interrupted.content) {
      expect(chunk.byteLength).toBeGreaterThan(0);
      break;
    }
    await interrupted.cancel();
    expect((await client.resolveOutputFile(target)).reference).toEqual(resolved.reference);

    const input = await client.prepareInputFromOutput({
      expectedStoreId: storeId,
      targetSessionId: 's',
      importId: 'edit-source',
      source: target,
      preparationId: 'edit-draft',
    });
    const prepare = {
      expectedStoreId: storeId,
      targetSessionId: 's',
      commandId: 'edit',
      files: [input],
    };
    expect((await client.prepareWorkingInputs(prepare)).files).toEqual([input]);
    const working = await store.getWorkingInput({
      ...base,
      commandId: 'edit',
      importId: 'edit-source',
    });
    expect(working?.state).toBe('ready');
    const workingPath = join(root, working!.workingRelativePath);
    expect(await readFile(workingPath, 'utf8')).toBe('original report');
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'edit',
      kind: 'run.start',
      content: 'Modify this report',
      files: [input],
    });
    await runtime.waitForCommand('edit', { timeoutMs: 5000 });
    const projected = JSON.stringify(model.requests.at(-1)?.messages);
    expect(projected).toContain('.kite-inputs/');
    expect(projected).not.toContain(input.reference!.hash);
    expect(projected).not.toContain(input.uri);
    await writeFile(workingPath, 'user edits already started');
    await client.prepareWorkingInputs(prepare);
    expect(await readFile(workingPath, 'utf8')).toBe('user edits already started');
    const original = await runtime.readArtifact({
      ...base,
      refId: resolved.reference.id,
      scope: resolved.reference.scope,
    });
    expect(new TextDecoder().decode(original.content)).toBe('original report');
    const mismatched = { ...target, sessionId: 'other' };
    let denied: unknown;
    try {
      await client.resolveOutputFile(mismatched, { signal: AbortSignal.timeout(2000) });
    } catch (error) {
      denied = error;
    }
    expect(denied).toMatchObject({ code: 'output_scope_denied' });
    expect(model.requests).toHaveLength(3);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
