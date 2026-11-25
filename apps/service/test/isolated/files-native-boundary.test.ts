import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createWorkspaceFiles, filesNativeAssets } from '@kite-ai/agent/files';
import { mcpSchemaWorkerAssets } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

test('actual default Service reads ordinary files and rejects protected assets and a replaced execution root', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-native-service-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const assets = filesNativeAssets().map((url) => fileURLToPath(url));
  const metadata = join(assets[1]!, 'manifest.json');
  const deniedNew = join(assets[1]!, `qualification-denied-${process.pid}.txt`);
  const original = readFileSync(metadata);
  const compilerAssets = [mcpSchemaWorkerAssets()].flatMap((assets) => [
    assets.worker,
    assets.checksum,
  ]);
  const originalCompilerBytes = compilerAssets.map((path) => readFileSync(path));
  expect(existsSync(deniedNew)).toBe(false);
  const ordinary = join(root, 'ordinary.txt');
  writeFileSync(ordinary, 'complete external ordinary text');
  const sourcePath = join(workspace, 'workspace.ts');
  writeFileSync(sourcePath, 'export const original = 42;\r\n');
  const replacementText = 'export const replacement = 99;\r\n';
  const workspaceReadProofs = new Map<string, string>();
  let modelCalls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as {
        tools: { function: { name: string; description: string } }[];
      };
      const find = (operation: string) =>
        input.tools.find((tool) => tool.function.name === `${operation}_file`)!.function.name;
      const calls = [
        [find('read'), { path: 'workspace.ts' }],
        [find('read'), { path: sourcePath }],
        [find('read'), { path: ordinary }],
        [find('read'), { path: metadata }],
        [find('read'), { path: assets[0] }],
        [find('write'), { path: deniedNew, content: 'must not publish' }],
        ...compilerAssets.flatMap((path) => [
          [find('read'), { path }],
          [find('write'), { path, content: 'must not overwrite' }],
        ]),
      ];
      modelCalls++;
      let toolCalls: typeof calls = modelCalls === 1 ? calls : [];
      if (modelCalls === 3) {
        // The next Run's opening Model request already carries the original workspace binding.
        renameSync(workspace, join(root, 'original-workspace'));
        mkdirSync(workspace);
        writeFileSync(sourcePath, replacementText);
        toolCalls = [calls[0]!];
      }
      const delta =
        toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map(([name, args], index) => ({
                index,
                id: `call-${modelCalls}-${index}`,
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
        `${chunk(delta, null)}${chunk({}, toolCalls.length ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
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
      tools: ['files.read', 'files.write'].map((id) => ({
        id,
        definitionVersion: id === 'files.read' ? '5' : '3',
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
  const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks?.(workspaceSerialLocks);
  const runtime = createRuntime({
    ...host,
    permissions: host.permissions!,
    store,
    artifacts,
    workspaceSerialLocks,
    async resolveRunConfiguration(input) {
      const resolved = await host.resolveRunConfiguration!(input);
      return {
        ...resolved,
        async readStepCapabilities(input) {
          const step = await resolved.readStepCapabilities!(input);
          return {
            ...step,
            toolBehaviors: step.toolBehaviors?.map((behavior) => {
              const { workspaceRead } = behavior;
              if (!workspaceRead) return behavior;
              return {
                ...behavior,
                async workspaceRead(request) {
                  const proof = await workspaceRead(request);
                  if (proof) workspaceReadProofs.set(request.executionId, proof.path);
                  return proof;
                },
              };
            }),
          };
        },
      };
    },
  });
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
    await initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      mode: 'full',
      trusted: true,
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
    expect(tools).toHaveLength(6 + compilerAssets.length * 2);
    for (const tool of tools.slice(0, 2)) {
      expect(tool.status, JSON.stringify(tool.result)).toBe('succeeded');
      expect(JSON.parse((tool.result as { content: string }).content)).toMatchObject({
        content: 'export const original = 42;\r\n',
        baseline: { hash: createHash('sha256').update(readFileSync(sourcePath)).digest('hex') },
      });
    }
    expect(workspaceReadProofs).toEqual(
      new Map(tools.slice(0, 2).map(({ id }) => [id, sourcePath])),
    );
    expect(tools[2]!.status, JSON.stringify(tools[2]!.result)).toBe('succeeded');
    expect((tools[2]!.result as { content: string }).content).toContain(
      'complete external ordinary text',
    );
    for (const tool of tools.slice(3)) {
      expect(tool.status).toBe('failed');
      expect(tool.result).toMatchObject({
        details: {
          code: 'permission_denied',
          reason: 'file_path_protected',
          adapterAttempted: false,
          dispatchCommitted: false,
        },
      });
      expect((tool.result as { content: string }).content).toContain('file_path_protected');
      expect((tool.result as { content: string }).content).not.toContain(
        'This is a limitation of this tool entry',
      );
    }
    expect(existsSync(deniedNew)).toBe(false);
    expect(readFileSync(metadata)).toEqual(original);
    for (const [index, path] of compilerAssets.entries())
      expect(readFileSync(path)).toEqual(originalCompilerBytes[index]!);
    expect(readFileSync(ordinary, 'utf8')).toBe('complete external ordinary text');
    expect(modelCalls).toBe(2);

    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'replaced-root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Verify access after replacing the workspace.' },
    });
    await runtime.waitForCommand('replaced-root', { timeoutMs: 10000 });
    expect(readFileSync(sourcePath, 'utf8')).toBe(replacementText);
    expect(workspaceReadProofs).toEqual(
      new Map(tools.slice(0, 2).map(({ id }) => [id, sourcePath])),
    );
    const afterReplacement = (await store.listExecutions('s')).filter(
      (row) => row.kind === 'tool' && row.originCommandId === 'replaced-root',
    );
    expect(afterReplacement).toHaveLength(1);
    expect(afterReplacement[0]!.status).toBe('failed');
    expect(afterReplacement[0]!.result).toMatchObject({
      content: 'execution_root_changed',
      details: {
        code: 'execution_root_changed',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    });
  } finally {
    await runtime.close();
    await workspaceSerialLocks.close();
    await artifacts.close();
    await store.close();
    provider.stop(true);
    rmSync(deniedNew, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('a held native Files owner rejects a stale Session root and closes before returning', async () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-root-replace-')));
  const root = join(fixture, 'workspace');
  const original = join(fixture, 'original');
  const replacement = join(fixture, 'replacement');
  let files: ReturnType<typeof createWorkspaceFiles> | undefined;
  try {
    mkdirSync(root);
    const before = lstatSync(root, { bigint: true });
    const expectedRootIdentity = { dev: String(before.dev), ino: String(before.ino) };
    renameSync(root, original);
    mkdirSync(root);
    expect(() => {
      files = createWorkspaceFiles({ root, expectedRootIdentity });
    }).toThrow('execution_root_changed');
    // Windows won't rename the replacement if the failed Files owner still pins it.
    renameSync(root, replacement);
    symlinkSync(original, root, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => {
      files = createWorkspaceFiles({ root, expectedRootIdentity });
    }).toThrow();
  } finally {
    await files?.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
