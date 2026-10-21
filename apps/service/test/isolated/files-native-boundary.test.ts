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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { filesNativeAssets } from '@kite-ai/agent/files';
import { mcpSchemaWorkerAssets } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { workflowCompilerAssets } from '@kite-ai/agent/skill-workflow';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createDefaultProcessConfiguration } from '../../src/configuration';

test('actual default Service keeps native and compiler assets protected in Full while an ordinary external file remains readable', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-native-service-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const assets = filesNativeAssets().map((url) => fileURLToPath(url));
  const metadata = join(assets[1]!, 'manifest.json');
  const deniedNew = join(assets[1]!, `qualification-denied-${process.pid}.txt`);
  const original = readFileSync(metadata);
  const compilerAssets = [mcpSchemaWorkerAssets(), workflowCompilerAssets()].flatMap((assets) => [
    assets.worker,
    assets.checksum,
  ]);
  const originalCompilerBytes = compilerAssets.map((path) => readFileSync(path));
  expect(existsSync(deniedNew)).toBe(false);
  const ordinary = join(root, 'ordinary.txt');
  writeFileSync(ordinary, 'complete external ordinary text');
  let modelCalls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as {
        tools: { function: { name: string; description: string } }[];
      };
      const find = (operation: string) =>
        input.tools.find((tool) => tool.function.name === `${operation}_user_file`)!.function.name;
      const calls = [
        [find('read'), { path: ordinary }],
        [find('read'), { path: metadata }],
        [find('read'), { path: assets[0] }],
        [find('write'), { path: deniedNew, content: 'must not publish', base: null }],
        ...compilerAssets.flatMap((path) => [
          [find('read'), { path }],
          [find('write'), { path, content: 'must not overwrite', base: null }],
        ]),
      ];
      const delta =
        modelCalls++ === 0
          ? {
              tool_calls: calls.map(([name, args], index) => ({
                index,
                id: `call-${index}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              })),
            }
          : { content: 'complete' };
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'response',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'local',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, modelCalls === 1 ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'local',
      models: [
        {
          id: 'local',
          provider: 'compatible',
          model: 'local',
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
        },
      ],
      tools: ['files.read_path', 'files.write_path'].map((id) => ({
        id,
        definitionVersion: id === 'files.read_path' ? '2' : '1',
      })),
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
    permissionPolicy: {
      readPolicy: (request) => ({
        mode: 'full',
        workspaceTrust: true,
        revision: 'native-full-qualification',
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      }),
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const artifacts = createArtifactStore({ profile, store });
  const runtime = createRuntime({ ...host, permissions: host.permissions!, store, artifacts });
  host.permissionManagement?.(runtime);
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 's',
      commandId: 'create',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'native',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'work',
      subjectId: 'owner',
      request: {
        kind: 'run.start',
        content: '新任务：Verify the exact ordinary read and native protection.',
      },
    });
    await runtime.waitForCommand('work', { timeoutMs: 10000 });
    const tools = (await store.listExecutions('s')).filter((row) => row.kind === 'tool');
    expect(tools).toHaveLength(4 + compilerAssets.length * 2);
    expect(tools[0]!.status).toBe('succeeded');
    expect((tools[0]!.result as { content: string }).content).toContain(
      'complete external ordinary text',
    );
    for (const tool of tools.slice(1)) {
      expect(tool.status).toBe('failed');
      expect(tool.result).toMatchObject({
        content: 'permission_denied',
        details: {
          reason: 'file_path_protected',
          adapterAttempted: false,
          dispatchCommitted: false,
        },
      });
    }
    expect(existsSync(deniedNew)).toBe(false);
    expect(readFileSync(metadata)).toEqual(original);
    for (const [index, path] of compilerAssets.entries())
      expect(readFileSync(path)).toEqual(originalCompilerBytes[index]!);
    expect(readFileSync(ordinary, 'utf8')).toBe('complete external ordinary text');
    expect(modelCalls).toBe(2);
  } finally {
    await runtime.close();
    await artifacts.close();
    await store.close();
    provider.stop(true);
    rmSync(deniedNew, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
