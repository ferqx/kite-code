import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const retired = [
  'activate_skill',
  'read_skill_reference',
  'complete_skill',
  'verify_skill',
  'repair_skill',
  'decide_skill_verification',
  'files.read_path',
  'files.write_path',
  'files.edit_path',
  'files.list',
  'files.glob',
  'files.search',
  'validation.define',
  'validation.check',
  'validation.rebind',
  'validation.auto_check',
  'validation.request_waiver',
];

async function fixture() {
  const root = temporaryDirectory('kite-retired-tools-');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(profile.profilePath);
  const user = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'fixed',
    models: [
      { id: 'fixed', provider: 'compatible', model: 'unused', baseURL: 'http://127.0.0.1:9/v1' },
    ],
  };
  const configure = (tools: { id: string }[] = []) =>
    writeFileSync(user, JSON.stringify({ ...configuration, tools }));
  configure();
  // A retained old configuration document cannot reactivate the removed runtime.
  writeFileSync(
    join(profile.profilePath, 'skill-workflow.jsonc'),
    JSON.stringify({
      version: 1,
      features: { skillActivation: true, skillWorkflow: true, verification: true },
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: user,
    localCodex: false,
    ordinaryHostTools: true,
    credentialBackend: createTemporaryCredentialBackend(),
  });
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: 'text_delta', text: 'ordinary task complete' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    extensions: host.extensions,
    permissions: host.permissions!,
    resolveRunConfiguration: async (input) => ({
      ...(await host.resolveRunConfiguration!(input)),
      model,
    }),
  });
  host.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'retirement',
    rootUri: pathToFileURL(workspace).href,
  });
  let counter = 0;
  const start = async (
    extensionInputs?: {
      extensionId: string;
      definitionVersion: string;
      input: { activations: never[] };
    }[],
  ) => {
    const sessionId = `s-${++counter}`,
      commandId = `run-${counter}`;
    const identity = { expectedStoreId, sessionId, subjectId: 'owner' };
    await runtime.createSession({
      ...identity,
      commandId: `create-${counter}`,
      workspaceId: 'w',
      title: 'retirement',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      ...identity,
      workspaceId: 'w',
      mode: 'full',
      trusted: true,
    });
    await runtime.submitCommand({
      ...identity,
      commandId,
      request: {
        kind: 'run.start',
        content: 'Inspect the ordinary tool surface',
        ...(extensionInputs ? { extensionInputs } : {}),
      },
    });
    const deadline = Date.now() + 10000;
    for (;;) {
      const view = await runtime.getView(sessionId);
      const command = await runtime.getCommand(commandId);
      const run = view.runs.find((run) => run.originCommandId === commandId);
      if ((run && !run.isActive) || command?.status === 'rejected') return { run, command, view };
      if (Date.now() > deadline)
        throw Error(`retired_tool_run_deadline:${JSON.stringify(command)}`);
      await sleepTimer(5);
    }
  };
  return {
    root,
    requests,
    configure,
    start,
    host,
    async close() {
      await runtime.close();
      await store.close();
      if (realpathSync.native(root) !== root) throw Error('retirement_cleanup_scope_changed');
      const check = (path: string) => {
        if (lstatSync(path).isSymbolicLink()) throw Error('retirement_cleanup_link');
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const selected = join(path, entry.name);
          if (entry.isSymbolicLink()) throw Error('retirement_cleanup_link');
          if (entry.isDirectory()) check(selected);
        }
      };
      check(root);
      rmSync(root, { recursive: true });
    },
  };
}

test('ordinary Run retains workspace tools while old Workflow flags register no executable tools or catalogue capability', async () => {
  const f = await fixture();
  try {
    const result = await f.start();
    expect(result.run?.status).toBe('completed');
    expect(f.requests).toHaveLength(1);
    const names = f.requests[0]!.tools.map((tool) => tool.id);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    for (const name of [
      ...retired,
      'read_user_file',
      'write_user_file',
      'edit_user_file',
      'list_directory',
      'glob_files',
      'search_content',
      'define_validation_checks',
      'run_validation_checks',
      'rebind_validation_check',
      'check_file_changes',
      'request_validation_waiver',
    ])
      expect(names).not.toContain(name);
    expect(
      f.host
        .extensions!.flatMap((extension) => extension.tools ?? [])
        .some((tool) => retired.includes(tool.id)),
    ).toBe(false);
    expect(Object.hasOwn(f.host.skillCatalogue!, 'supportsWorkflow')).toBe(false);
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../packages/agent/package.json', import.meta.url), 'utf8'),
    );
    expect(manifest.exports).not.toHaveProperty('./skill-workflow');
  } finally {
    await f.close();
  }
}, 20000);

test('explicit selection of every retired Tool rejects the Run before any Model or Tool effect', async () => {
  const f = await fixture();
  try {
    for (const id of retired) {
      f.configure([{ id }]);
      const result = await f.start();
      expect(result.command?.status, id).toBe('rejected');
      expect(result.view.runs, id).toHaveLength(0);
      expect(result.view.executions, id).toHaveLength(0);
    }
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 20000);

test('old Workflow activation input remains readable and is rejected before a Model or child starts', async () => {
  const f = await fixture();
  try {
    const result = await f.start([
      { extensionId: 'builtin.skill-workflow', definitionVersion: '1', input: { activations: [] } },
    ]);
    expect(result.command?.status).toBe('rejected');
    expect(result.view.runs).toHaveLength(0);
    expect(result.view.executions).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 20000);
