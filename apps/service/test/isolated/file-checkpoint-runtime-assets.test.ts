import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
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
import { pathToFileURL } from 'node:url';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import type { ToolContext } from '@kite-ai/agent/extensions';
import { createWorkspaceFiles } from '@kite-ai/agent/files';
import { selectProfile } from '@kite-ai/agent/profile';
import { sqliteStorageAssets } from '@kite-ai/agent/sqlite';
import type { ExecutionGroupSafety, ExtensionRecord, Json } from '@kite-ai/agent/storage';
import { createDefaultFileCheckpointConfiguration } from '../../src/file-checkpoint-configuration';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(',')}}`;
}
async function code(operation: Promise<unknown>) {
  try {
    const value = await operation;
    return value && typeof value === 'object' && 'details' in value
      ? ((value.details as { code?: string })?.code ?? null)
      : null;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}

/** Scope leaf qualification only: trusted finite observation/record ports, actual OS files.
 * This is not Core dispatch/finalSQL/default-main or ArtifactStore qualification. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-runtime-assets-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'owned' });
  let assets: readonly string[] = [];
  let runtimeReads = 0,
    assetReads = 0;
  const originalSelectionReads: Parameters<AgentRuntime['readOriginalRunSelection']>[0][] = [];
  const records = new Map<string, ExtensionRecord>(),
    bodies = new Map<string, Uint8Array>();
  const session = {
    id: 's',
    workspaceId: 'w',
    rootSessionId: 's',
    contextSelectionId: 'selected',
    deletedAt: null,
  };
  const run = {
    id: 'run',
    sessionId: 's',
    originCommandId: 'work',
    originStoreId: 'store',
    rootWorkCommandId: 'work',
    contextSelectionId: 'selected',
    isActive: true,
  };
  const model = {
    id: 'model',
    kind: 'model',
    status: 'succeeded',
    sessionId: 's',
    runId: 'run',
    originCommandId: 'work',
    originStoreId: 'store',
    contextSelectionId: null,
    decisionSource: { kind: 'model_decision' },
  };
  let tool = {
    ...model,
    id: 'tool',
    kind: 'tool',
    status: 'dispatching',
    definitionId: 'files.write',
    definitionVersion: '2',
    attempt: 1,
    input: {} as Json,
    result: null as Json,
    inputDigest: '',
    decisionSource: { kind: 'model_decision', modelExecutionId: 'model' },
    rootWorkCommandId: 'work',
  };
  const message = {
    id: 'user',
    seq: '1',
    sessionId: 's',
    runId: 'run',
    status: 'complete',
    role: 'user',
    content: 'ordinary user input',
    sourceIds: ['work'],
  };
  const safety = {
    sessionId: 's',
    rootSessionId: 's',
    originStoreId: 'store',
    quiescent: true,
  } as ExecutionGroupSafety;
  // This fixture qualifies the scope leaf with finite observation ports, not a
  // SQLite/Runtime lifecycle. Historical selection is pinned to the original
  // fixture Run and subject; it cannot fall back to a later current selection.
  const originalSelection: Pick<AgentRuntime, 'readOriginalRunSelection'> = {
    async readOriginalRunSelection(input) {
      runtimeReads++;
      if (input.expectedStoreId !== run.originStoreId)
        throw new AgentError('store_identity_mismatch');
      if (input.subjectId !== 'owner') throw new AgentError('context_scope_denied');
      if (input.sessionId !== run.sessionId || input.runId !== run.id)
        throw new AgentError('original_run_selection_unverifiable');
      originalSelectionReads.push(structuredClone(input));
      return {
        selection: {
          id: run.contextSelectionId,
          sessionId: run.sessionId,
          previousSelectionId: null,
          boundaryMessageId: null,
          boundarySeq: '0',
          tailFromSeq: '0',
          ranges: [],
        },
        highWaterSeq: '2',
      };
    },
  };
  const runtime = {
    ...originalSelection,
    async getMetadata() {
      runtimeReads++;
      return { storeId: 'store' };
    },
    async getSession(id: string) {
      runtimeReads++;
      return id === 's' ? session : null;
    },
    async getWorkspace(id: string) {
      runtimeReads++;
      return id === 'w' ? { id: 'w', rootUri: pathToFileURL(workspace).href } : null;
    },
    async getRun(id: string) {
      runtimeReads++;
      return id === 'run' ? run : null;
    },
    async getCommand(id: string) {
      runtimeReads++;
      return id === 'work'
        ? { id: 'work', sessionId: 's', originStoreId: 'store', subjectId: 'owner' }
        : null;
    },
    async getExecution(id: string) {
      runtimeReads++;
      return id === 'tool' ? tool : id === 'model' ? model : null;
    },
    async getSelectedContext() {
      runtimeReads++;
      return {
        selection: { id: 'selected', tailFromSeq: '0', ranges: [] },
        highWaterSeq: '2',
        messages: [message],
      };
    },
    async listMessages(_id: string, options: { afterSeq: string }) {
      runtimeReads++;
      return options.afterSeq === '0' ? [message] : [];
    },
    async readModelInput() {
      runtimeReads++;
      return {
        executionId: 'model',
        sessionId: 's',
        confirmation: 'succeeded',
        runId: 'run',
        originCommandId: 'work',
        rootWorkCommandId: 'work',
        bodyHash: hash('immutable actual fixture input'),
        bodyBytes: '32',
        request: {
          messages: [{ role: 'user', content: message.content, sourceIds: message.sourceIds }],
        },
      };
    },
  } as unknown as AgentRuntime;
  const context = {
    sessionId: 's',
    runId: 'run',
    executionId: 'tool',
    signal: new AbortController().signal,
    async readExecutionGroupSafety() {
      return safety;
    },
    async requireExecutionGroupQuiescent() {
      return safety;
    },
    getRun: runtime.getRun.bind(runtime),
    getExecution: runtime.getExecution.bind(runtime),
    records: {
      async get(key: string) {
        return records.get(key) ?? null;
      },
      async list(options = {}) {
        const filter = options as { contentType?: string; afterKey?: string; limit?: number };
        return [...records.values()]
          .filter(
            (row) =>
              (!filter.contentType || row.contentType === filter.contentType) &&
              (!filter.afterKey || row.key > filter.afterKey),
          )
          .sort((a, b) => a.key.localeCompare(b.key))
          .slice(0, filter.limit ?? 200);
      },
      async write(input: {
        key: string;
        expectedRevision: string | null;
        contentType: string;
        contentVersion: number;
        value: Json;
      }) {
        const old = records.get(input.key);
        if ((old?.revision ?? null) !== input.expectedRevision)
          throw new Error('fixture CAS conflict');
        const row = {
          ...input,
          extensionId: 'builtin.files',
          sessionId: 's',
          scope: { kind: 'session', id: 's' },
          originStoreId: 'store',
          revision: String(Number(old?.revision ?? 0) + 1),
        } as unknown as ExtensionRecord;
        records.set(input.key, row);
        return row;
      },
    },
    artifacts: {
      async publish(input: { content: Uint8Array; mediaType: string }) {
        const id = hash(input.content);
        bodies.set(id, Uint8Array.from(input.content));
        return {
          id,
          mediaType: input.mediaType,
          size: String(input.content.length),
          scope: { kind: 'execution' as const, id: 'tool' },
        };
      },
      async read(ref: { id: string }) {
        return bodies.get(ref.id)!;
      },
    },
  } as unknown as ToolContext;
  function configuration(selectedProfile = profile) {
    return createDefaultFileCheckpointConfiguration({
      profile: selectedProfile,
      runtime() {
        runtimeReads++;
        return runtime;
      },
      runtimeAssets() {
        assetReads++;
        return assets;
      },
    });
  }
  return {
    root,
    workspace,
    profile,
    context,
    records,
    originalSelectionReads,
    run,
    configuration,
    setAssets(value: readonly string[]) {
      assets = value;
    },
    get runtimeReads() {
      return runtimeReads;
    },
    get assetReads() {
      return assetReads;
    },
    async execute(id: string, input: Json) {
      const mutation = ['files.write', 'files.edit'].includes(id);
      if (mutation)
        tool = {
          ...tool,
          definitionId: id,
          input,
          inputDigest: hash(canonical(input)),
          status: 'dispatching',
        };
      const definition = configuration().tools.find((value) => value.id === id)!;
      const result = await definition.execute(input, context);
      if (mutation) {
        tool.status = result.outcome;
        tool.result = result as unknown as Json;
      }
      return result;
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('pure default Files metadata does not resolve Runtime or filesystem assets and assets are not caller schema inputs', () => {
  const profile = selectProfile({
    dataRoot: '/private/tmp/unopened-checkpoint-runtime-assets',
    profile: 'owned',
  });
  let calls = 0;
  const configuration = createDefaultFileCheckpointConfiguration({
    profile,
    runtime() {
      calls++;
      throw new Error('must remain lazy');
    },
    runtimeAssets() {
      calls++;
      throw new Error('must remain lazy');
    },
  });
  expect(calls).toBe(0);
  expect(configuration.tools).toHaveLength(6);
  expect(configuration.extension.actions![0]!.inputSchema).toMatchObject({
    additionalProperties: false,
    required: ['checkpointId', 'restoreId'],
  });
  for (const tool of configuration.tools) {
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
    expect(
      (tool.inputSchema as { properties: Record<string, unknown> }).properties.runtimeAssets,
    ).toBeUndefined();
  }
  expect(configuration.tools.map((tool) => tool.id)).toEqual([
    'files.read',
    'files.write',
    'files.edit',
    'files.list',
    'files.glob',
    'files.search',
  ]);
  const actual = sqliteStorageAssets();
  expect(actual.worker.pathname.endsWith('/storage/worker/main.ts')).toBe(true);
  expect(actual.baseline.pathname.endsWith('/storage/migrations/0001-baseline.sql')).toBe(true);
});

test('actual file, directory and missing loader companion protection rejects read/write/edit while a neighboring file stays usable', async () => {
  const f = fixture();
  const baselineFiles = createWorkspaceFiles({ root: f.workspace });
  try {
    mkdirSync(join(f.workspace, 'runtime'));
    writeFileSync(join(f.workspace, 'runtime', 'worker.js'), 'immutable worker');
    writeFileSync(join(f.workspace, 'loader.js'), 'immutable loader');
    writeFileSync(join(f.workspace, 'loader.js-neighbor'), 'original neighbor');
    f.setAssets([
      join(f.workspace, 'runtime'),
      join(f.workspace, 'loader.js'),
      join(f.workspace, 'missing.js'),
    ]);
    const loaderBase = (await baselineFiles.read('loader.js')).baseline;
    const readCodes: string[] = [];
    for (const path of ['loader.js', 'runtime/worker.js', 'missing.js']) {
      readCodes.push(String(await code(f.execute('files.read', { path }))));
      expect(
        await code(
          f.execute('files.write', {
            path,
            base: path === 'loader.js' ? { ...loaderBase } : null,
            content: 'replace',
          }),
        ),
      ).toBe('file_path_protected');
    }
    expect(
      await code(
        f.execute('files.edit', {
          path: 'loader.js',
          base: { ...loaderBase },
          find: 'immutable',
          replace: 'replace',
          occurrences: 1,
        }),
      ),
    ).toBe('file_path_protected');
    expect(readFileSync(join(f.workspace, 'loader.js'), 'utf8')).toBe('immutable loader');
    expect(existsSync(join(f.workspace, 'missing.js'))).toBe(false);
    const neighborBase = (await baselineFiles.read('loader.js-neighbor')).baseline;
    expect(
      (
        await f.execute('files.write', {
          path: 'loader.js-neighbor',
          base: { ...neighborBase },
          content: 'new neighbor',
        })
      ).outcome,
    ).toBe('succeeded');
    expect(readFileSync(join(f.workspace, 'loader.js-neighbor'), 'utf8')).toBe('new neighbor');
    expect(f.assetReads).toBeGreaterThan(0);
    const rootList = await f.execute('files.list', {});
    expect(rootList.outcome).toBe('succeeded');
    expect(
      JSON.parse(rootList.content).entries.map((entry: { name: string }) => entry.name),
    ).toEqual(['loader.js-neighbor']);
    const glob = await f.execute('files.glob', { pattern: '**/*' });
    expect(glob.outcome).toBe('succeeded');
    expect(JSON.parse(glob.content).paths).toEqual(['loader.js-neighbor']);
    const search = await f.execute('files.search', { text: 'immutable' });
    expect(search.outcome).toBe('succeeded');
    expect(JSON.parse(search.content).matches).toEqual([]);
    for (const [id, input] of [
      ['files.list', { path: 'runtime' }],
      ['files.glob', { path: 'runtime', pattern: '**/*' }],
      ['files.search', { path: 'runtime', text: 'immutable' }],
    ] as const)
      expect(await code(f.execute(id, input))).toBe('file_path_protected');
    const point = [...f.records.values()].find(
      (row) => row.contentType === 'builtin.files.checkpoint',
    )!;
    f.run.isActive = false;
    f.setAssets([join(f.workspace, 'loader.js-neighbor')]);
    const action = f.configuration().extension.actions![0]!;
    expect(
      await code(
        action.prepare(
          { checkpointId: (point.value as { id: string }).id, restoreId: 'restore' },
          f.context,
        ),
      ),
    ).toBe('checkpoint_restore_conflict');
    expect(f.originalSelectionReads).toContainEqual({
      expectedStoreId: 'store',
      sessionId: 's',
      subjectId: 'owner',
      runId: 'run',
    });
    expect(readFileSync(join(f.workspace, 'loader.js-neighbor'), 'utf8')).toBe('new neighbor');
    expect([...f.records.keys()].some((key) => key === 'checkpoint/restore/restore')).toBe(false);
    expect(readCodes).toEqual([
      'file_path_protected',
      'file_path_protected',
      'file_path_protected',
    ]);
  } finally {
    await baselineFiles.close();
    f.close();
  }
});

test('profile protection canonicalizes actual ancestor aliases; assets containing the Workspace and invalid trusted inventories fail closed', async () => {
  const f = fixture();
  try {
    const alias = join(f.root, 'alias');
    symlinkSync(f.workspace, alias);
    mkdirSync(join(f.workspace, 'private-data'));
    writeFileSync(join(f.workspace, 'private-data', 'secret'), 'original private bytes');
    writeFileSync(join(f.workspace, 'private-data-neighbor'), 'neighbor');
    const profile = {
      ...f.profile,
      dataRoot: join(alias, 'private-data'),
      profilePath: join(alias, 'private-data', 'owned'),
      coordinationPath: join(alias, 'private-data', '.coordination'),
    };
    const profileTools = f.configuration(profile).tools;
    const tool = profileTools.find((tool) => tool.id === 'files.read')!;
    const privateRead = await code(tool.execute({ path: 'private-data/secret' }, f.context));
    expect((await tool.execute({ path: 'private-data-neighbor' }, f.context)).outcome).toBe(
      'succeeded',
    );
    for (const [id, input] of [
      ['files.list', {}],
      ['files.glob', { pattern: '**/*' }],
      ['files.search', { text: 'original private bytes' }],
    ] as const) {
      const result = await profileTools.find((tool) => tool.id === id)!.execute(input, f.context);
      expect(result.outcome).toBe('succeeded');
      expect(result.content).not.toContain('secret');
      expect(result.content).not.toContain('original private bytes');
      expect(result.content).not.toContain('"private-data"');
    }
    for (const assets of [
      [f.root],
      ['relative-loader'],
      Array.from({ length: 129 }, () => join(f.root, 'loader')),
    ]) {
      f.setAssets(assets);
      expect(
        await code(
          f.configuration().tools[0]!.execute({ path: 'private-data-neighbor' }, f.context),
        ),
      ).toBe(
        assets[0] === f.root
          ? 'checkpoint_workspace_protected'
          : 'checkpoint_runtime_assets_invalid',
      );
    }
    expect(readFileSync(join(f.workspace, 'private-data', 'secret'), 'utf8')).toBe(
      'original private bytes',
    );
    expect(f.records.size).toBe(0);
    expect(privateRead).toBe('file_path_protected');
  } finally {
    f.close();
  }
});

test('scoped reads resolve the current original Workspace rather than reusing a previous operation capability', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, 'ordinary'), 'first original root');
    const tool = f.configuration().tools.find((tool) => tool.id === 'files.read')!;
    expect((await tool.execute({ path: 'ordinary' }, f.context)).content).toContain(
      'first original root',
    );
    renameSync(f.workspace, join(f.root, 'old-root'));
    mkdirSync(f.workspace);
    writeFileSync(join(f.workspace, 'ordinary'), 'second actual root');
    expect((await tool.execute({ path: 'ordinary' }, f.context)).content).toContain(
      'second actual root',
    );
    expect(readFileSync(join(f.root, 'old-root', 'ordinary'), 'utf8')).toBe('first original root');
    expect(f.records.size).toBe(0);
  } finally {
    f.close();
  }
});
