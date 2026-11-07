import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AuthorizationRequest,
  Extension,
  JobDefinition,
  ToolDefinition,
} from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import {
  createToolBehaviorRegistry,
  inheritToolBehaviorDefinition,
  type TrustedToolBehavior,
} from '../../../src/tool-behavior';
import { createFileToolBehaviors } from '../../../src/tools/files-approval';
import { createShellToolBehaviors } from '../../../src/tools/shell-approval';

const request = (
  definitionId: string,
  input: AuthorizationRequest['input'],
  definitionVersion = '1',
): AuthorizationRequest => ({
  kind: 'tool',
  definitionId,
  definitionVersion,
  sessionId: 'actual-session',
  runId: 'run',
  executionId: 'execution',
  input,
  signal: new AbortController().signal,
});
const tool: ToolDefinition = {
  id: 'test.custom',
  version: '1',
  description: 'fixture',
  inputSchema: { type: 'object' },
  async execute() {
    return { outcome: 'succeeded', content: 'done' };
  },
};
test('trusted behavior requires the registered object, preserves private Runtime sealing provenance and freezes binding identity', () => {
  const extension: Extension = { id: 'fixture', version: '1', apiMajor: 1, tools: [tool] };
  const behavior: TrustedToolBehavior = {
    definition: tool,
    capability: { kind: 'tool', definitionId: tool.id, definitionVersion: tool.version },
    contractRef: 'fixture.custom-format',
    configurationDigest: 'a'.repeat(64),
    autoReview: 'check',
    async prepareReview() {
      return {
        instructions: 'review fixture',
        material: { value: 1 },
        fingerprint: 'b'.repeat(64),
        reusable: false,
      };
    },
    interpretReview(content) {
      return content === 'CUSTOM ALLOW'
        ? { answer: { decision: 'approve_once', reason: 'fixture' } }
        : null;
    },
  };
  const registry = createToolBehaviorRegistry({ extensions: [extension], behaviors: [behavior] });
  expect(
    registry.get(request(tool.id, {}))!.interpretReview!('CUSTOM ALLOW')?.answer.decision,
  ).toBe('approve_once');
  expect(registry.get(request(tool.id, {}, '2'))).toBeUndefined();
  expect(Object.isFrozen(registry.bindings[0]!.capability)).toBe(true);
  expect(() =>
    createToolBehaviorRegistry({
      extensions: [{ ...extension, tools: [{ ...tool }] }],
      behaviors: [behavior],
    }),
  ).toThrow('tool_behavior_binding_invalid');
  expect(() =>
    createToolBehaviorRegistry({ extensions: [extension], behaviors: [behavior, behavior] }),
  ).toThrow('tool_behavior_duplicate_binding');
  const sealed = { ...tool };
  inheritToolBehaviorDefinition(tool, sealed);
  expect(
    createToolBehaviorRegistry({
      extensions: [{ ...extension, tools: [sealed] }],
      behaviors: [behavior],
    }).get(request(tool.id, {})),
  ).toBeDefined();
});
test('file edit and write share an exact parent slot across atomic replacement and new contents; missing parents never create a scope', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-scope-')));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'file.txt'), 'first');
    const files = createWorkspaceFiles({ root, protectedPaths: ['private'] });
    const tools = createFileTools(files);
    const behaviors = createFileToolBehaviors({
      tools,
      async readFiles() {
        return {
          workspaceId: 'workspace',
          root,
          files: createWorkspaceFiles({ root, protectedPaths: ['private'] }),
        };
      },
    });
    const edit = behaviors.find((entry) => entry.capability.definitionId === 'files.edit')!;
    const write = behaviors.find((entry) => entry.capability.definitionId === 'files.write')!;
    const original = (
      await edit.grantOffers!(
        request(
          'files.edit',
          {
            path: 'nested/file.txt',
            base: { hash: 'irrelevant' },
            find: 'first',
            replace: 'second',
          },
          '2',
        ),
      )
    )[0]!;
    const baseline = (await files.read('nested/file.txt')).baseline;
    await files.write({
      path: 'nested/file.txt',
      content: 'second different body',
      base: baseline,
    });
    const current = (
      await write.grantOffers!(
        request('files.write', { path: 'nested/file.txt', base: null, content: 'third' }, '3'),
      )
    )[0]!;
    expect(current.scopeDigest).toBe(original.scopeDigest);
    expect(current.bindings).toEqual([
      { kind: 'tool', definitionId: 'files.write', definitionVersion: '3' },
      { kind: 'tool', definitionId: 'files.edit', definitionVersion: '2' },
    ]);
    const other = (
      await write.grantOffers!(request('files.write', { path: 'nested/other.txt' }, '3'))
    )[0]!;
    expect(other.scopeDigest).not.toBe(original.scopeDigest);
    expect(
      await write.grantOffers!(request('files.write', { path: 'absent/child.txt' }, '3')),
    ).toEqual([]);
    expect(
      await write.grantOffers!(request('files.write', { path: 'private/child.txt' }, '3')),
    ).toEqual([]);
    expect(
      await write.grantOffers!(
        request('files.write', { path: join(root, '..', 'outside.txt') }, '3'),
      ),
    ).toEqual([]);
    await files.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('Shell owner prepares complete untrusted operation, maps risk output and binds the original command digest', async () => {
  const definition = { ...tool, id: 'shell.execute' };
  const behaviors = createShellToolBehaviors({
    extensions: [{ id: 'builtin.shell', version: '1', apiMajor: 1, tools: [definition] }],
    snapshot: { cwd: '/workspace' },
    commandDigest: () => 'c'.repeat(64),
    async prepareRiskReview() {
      return {
        material: { cwd: '/workspace', scripts: [] },
        fingerprint: 'd'.repeat(64),
        reusable: false,
      };
    },
  });
  const behavior = behaviors[0]!;
  const prepared = await behavior.prepareReview!(
    request('shell.execute', { command: 'node app.js', description: 'model claim' }),
  );
  expect(prepared!.material).toEqual({
    purpose: 'shell_risk',
    operation: {
      kind: 'tool',
      definitionId: 'shell.execute',
      definitionVersion: '1',
      input: { command: 'node app.js' },
    },
    material: { cwd: '/workspace', scripts: [] },
  });
  expect(
    behavior.interpretReview!('{"risk":"critical","reason":"credential exfiltration"}')?.answer
      .decision,
  ).toBe('reject');
  expect(
    behavior.interpretReview!('{"risk":"high","reason":"destructive shared remote"}')?.answer
      .decision,
  ).toBe('ask_user');
  expect(
    behavior.interpretReview!('{"risk":"ordinary","reason":"reads local files"}')?.answer.decision,
  ).toBe('approve_once');
  expect(behavior.interpretReview!('{"decision":"approve_once","reason":"fake"}')).toBeNull();
  expect(
    (await behavior.grantOffers!(request('shell.execute', { command: 'node app.js' })))[0]!.scope,
  ).toEqual({ commandDigest: 'c'.repeat(64) });
  expect(behavior.grantSatisfiesDefaultCheck).toBe(true);
  expect(behavior.prepareParentProof).toBeFunction();
  const custom = createShellToolBehaviors({
    extensions: [{ id: 'builtin.shell', version: '1', apiMajor: 1, tools: [definition] }],
    snapshot: { cwd: '/workspace' },
    enableReview: false,
    commandDigest: () => 'c'.repeat(64),
    async prepareRiskReview() {
      throw Error('must not prepare custom checker');
    },
  })[0]!;
  expect(custom.prepareReview).toBeUndefined();
  expect(custom.interpretReview).toBeUndefined();
  expect(custom.grantSatisfiesDefaultCheck).toBeUndefined();
  expect(
    await custom.grantOffers!(request('shell.execute', { command: 'node app.js' })),
  ).toHaveLength(1);
});
test('Shell parent proof names only the verified exact parent operation and preserves cancellation and complete input binding', async () => {
  const parentDefinition = { ...tool, id: 'shell.execute' };
  const never = async () => {
    throw Error('fixture must not start');
  };
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'fixture',
    inputSchema: { type: 'object' },
    start: never,
    observe() {
      throw Error('never');
    },
    cancel: never,
    dispose: never,
  };
  const behaviors = createShellToolBehaviors({
    extensions: [
      { id: 'builtin.shell', version: '1', apiMajor: 1, tools: [parentDefinition], jobs: [job] },
    ],
    snapshot: { cwd: '/workspace', host: { trusted: true } },
    commandDigest: () => 'a'.repeat(64),
    async prepareRiskReview() {
      return { material: { cwd: '/workspace' }, fingerprint: 'b'.repeat(64), reusable: true };
    },
  });
  const behavior = behaviors.find((entry) => entry.capability.kind === 'job')!;
  const target = {
    ...request('shell.command', {
      command: 'node app.js',
      permissions: { filesystem: 'workspace_write', network: 'none' },
    }),
    kind: 'job' as const,
  };
  const parent = {
    executionId: 'actual-parent',
    kind: 'tool' as const,
    definitionId: 'shell.execute',
    definitionVersion: '1',
    input: {
      command: 'node app.js',
      execution_timeout_ms: 2000,
      cancellation: 'detached',
    } as const,
    inputDigest: 'c'.repeat(64),
  };
  let parentReads = 0;
  const context = {
    get parent() {
      parentReads++;
      return parent;
    },
  };
  expect(await behavior.prepareParentProof!(target, context)).toMatchObject({
    parentExecutionId: 'actual-parent',
    parentInputDigest: 'c'.repeat(64),
    cancelWithParent: false,
  });
  const prepared = await behavior.prepareReview!(target, context);
  expect(prepared).not.toBeNull();
  expect(prepared!.parentProof).toBeUndefined();
  expect(parentReads).toBe(1);
  expect(
    await behavior.prepareParentProof!(target, {
      parent: { ...parent, input: { command: 'different' } },
    }),
  ).toBeNull();
  expect(
    await behavior.prepareParentProof!(target, {
      parent: { ...parent, definitionId: 'same-name-untrusted' },
    }),
  ).toBeNull();
  expect(
    await behavior.prepareParentProof!(target, {
      parent: { ...parent, input: { command: 'node app.js', filesystem: 'full_access' } },
    }),
  ).toBeNull();
  const custom = createShellToolBehaviors({
    extensions: [
      { id: 'builtin.shell', version: '1', apiMajor: 1, tools: [parentDefinition], jobs: [job] },
    ],
    snapshot: { cwd: '/workspace', host: { trusted: true } },
    enableReview: false,
    commandDigest: () => 'a'.repeat(64),
    async prepareRiskReview() {
      throw Error('must not review');
    },
  }).find((entry) => entry.capability.kind === 'job')!;
  expect(await custom.prepareParentProof!(target, { parent })).toMatchObject({
    parentExecutionId: 'actual-parent',
    parentInputDigest: 'c'.repeat(64),
    cancelWithParent: false,
  });
});
