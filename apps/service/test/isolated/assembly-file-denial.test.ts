import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelRequest } from '@kite-ai/ai';
import { createWorkspaceAssembly } from '../../src/assembly';

test('an outside Files target reaches the ordinary denial result and the original Run continues without outside instructions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-assembly-file-denial-')));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(workspace, 'AGENTS.md'), 'Workspace instruction marker');
  writeFileSync(join(outside, 'AGENTS.md'), 'Outside instruction must never be read');
  writeFileSync(join(outside, 'secret.txt'), 'Outside bytes must never be read');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore(profile);
  const assembly = await createWorkspaceAssembly({
    workspaceRoot: workspace,
    profile,
    toolIds: ['files.read'],
  });
  const requests: ModelRequest[] = [];
  const runtime = createRuntime({
    store,
    extensions: assembly.extensions,
    sources: assembly.sources,
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned-fixture' }) },
    model: {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'outside-read',
            name: 'read_file',
            arguments: JSON.stringify({ path: join(outside, 'secret.txt') }),
          };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else {
          yield { type: 'text_delta', text: 'The file is outside this workspace.' };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      name: 'Owned fixture',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'workspace',
      title: 'Denied file',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Try the outside file and explain the result.' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 10_000 });
    expect(command.status).toBe('applied');
    expect((await store.getRun((command.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(requests).toHaveLength(2);
    const tools = (await store.listExecutions('session')).filter((item) => item.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('failed');
    expect(tools[0]!.result).toMatchObject({
      outcome: 'failed',
      details: { code: 'file_path_invalid' },
    });
    expect(JSON.stringify(requests[1])).toContain('file_path_invalid');
    expect(JSON.stringify(requests)).toContain('Workspace instruction marker');
    expect(JSON.stringify(requests)).not.toContain('Outside instruction must never be read');
    expect(JSON.stringify(requests)).not.toContain('Outside bytes must never be read');
    await expect(
      assembly.sources.capture({
        workspaceId: 'workspace',
        sessionId: 'session',
        definitionId: 'files.read',
        input: { path: '../outside/secret.txt' },
      }),
    ).resolves.toHaveLength(2);
    if (process.platform === 'win32') {
      await expect(
        assembly.sources.capture({
          workspaceId: 'workspace',
          sessionId: 'session',
          definitionId: 'files.read',
          input: {
            path: workspace.toUpperCase().startsWith('Z:') ? 'Y:/outside.txt' : 'Z:/outside.txt',
          },
        }),
      ).resolves.toHaveLength(2);
    }
    writeFileSync(join(workspace, 'AGENTS.md'), '\0invalid instructions');
    await expect(
      assembly.sources.capture({
        workspaceId: 'workspace',
        sessionId: 'session',
        definitionId: 'files.read',
        input: { path: join(outside, 'secret.txt') },
      }),
    ).rejects.toMatchObject({ code: 'context_source_unavailable' });
  } finally {
    await runtime.close();
    await assembly.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
