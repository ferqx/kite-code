import { expect, test } from 'bun:test';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Json, SessionExecutionRoot, Store } from '@kite-ai/agent/storage';
import type { AgentClient } from '@kite-ai/client';
import { Sidebar } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { semanticDigest } from '../../../../packages/agent/src/json';
import {
  collectDirectory,
  collectSnapshotDirectory,
} from '../../../../packages/client/src/directory';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { NativeCaller } from '../../electron/native-caller';
import type { NativeDirectory } from '../../src/native-bridge';
import { NativeDirectoryProjection } from '../../src/native-presentation';

const source = { rootUri: 'file:///source', identity: { dev: '1', ino: '10' } };
const target = { rootUri: 'file:///linked', identity: { dev: '1', ino: '20' } };

// Only the transport is replaced: Main consumes real Store directory pages through
// the SDK collectors, then its exact NativeDirectory reaches the production UI projection.
function directoryCaller(store: Store, storeId: string) {
  const client = {
    serverInfo: { storeId, subjectId: 'owner', capabilities: ['session_directory_activity'] },
    connect: async () => ({}),
    async observe({ signal }: { signal: AbortSignal }) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    disposeNetwork() {},
    async listAllWorkspaces({ signal }: { signal?: AbortSignal }) {
      const items = await collectDirectory(
        (page) => store.listWorkspaceDirectory({ expectedStoreId: storeId, ...page, limit: 1 }),
        signal,
        (item) => item.workspace.id,
      );
      return items.map((item) => item.workspace);
    },
    listAllSessionDirectory({ signal }: { signal?: AbortSignal }) {
      return collectSnapshotDirectory(
        (page) =>
          store.listSessionDirectory({
            expectedStoreId: storeId,
            subjectId: 'owner',
            ...page,
            limit: 1,
          }),
        signal,
        (item) => item.session.id,
      );
    },
  } as unknown as AgentClient;
  return new NativeCaller(client, () => {});
}

test('use and exit retain the original space and Session in real Store pages, Main directory and Native Sidebar', async () => {
  const directory = temporaryDirectory('kite-native-root-directory-');
  const profile = { dataRoot: directory, profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'owner' };
  let caller: NativeCaller | undefined;
  let cold: Store | undefined;
  let coldCaller: NativeCaller | undefined;
  try {
    for (const [id, name, rootUri] of [
      ['original', 'Original space', source.rootUri],
      ['linked', 'Already registered linked space', target.rootUri],
    ])
      await store.createWorkspace({ expectedStoreId, id: id!, name: name!, rootUri: rootUri! });
    for (const [sessionId, workspaceId] of [
      ['current', 'original'],
      ['other', 'original'],
      ['linked-session', 'linked'],
    ])
      await store.createSession({
        ...base,
        sessionId: sessionId!,
        workspaceId: workspaceId!,
        commandId: `create-${sessionId}`,
        title: sessionId!,
      });
    const owner = (await store.acquireSessionOwner('current', 'directory-regression'))!;
    const owned = { expectedStoreId, owner };
    await store.acceptCommand({
      ...base,
      sessionId: 'current',
      commandId: 'start',
      request: { kind: 'run.start', content: 'use and exit a worktree' },
    });
    const run = await store.startRun({
      ...owned,
      commandId: 'start',
      configuration: {
        tools: [
          { id: 'git.worktree', version: '1', extensionId: 'builtin.shell' },
          { id: 'fixture/parent', version: '1', extensionId: 'fixture' },
        ],
        extensions: [{ id: 'builtin.shell', version: '1' }],
      },
    });
    async function execution(
      id: string,
      kind: 'model' | 'tool',
      input: Json,
      epoch: string,
      decisionSource: Json = {},
    ) {
      await store.planExecution({
        ...owned,
        executionId: id,
        sessionId: 'current',
        runId: run.id,
        originCommandId: 'start',
        stepId: id,
        callId: id,
        kind,
        definitionId:
          kind === 'model'
            ? 'fixture/model'
            : id.startsWith('parent')
              ? 'fixture/parent'
              : 'git.worktree',
        definitionVersion: '1',
        input,
        decisionSource,
      });
      await store.markDispatching({
        ...owned,
        executionId: id,
        authorization: {
          allowed: true,
          revision: 'test',
          definitionVersion: '1',
          inputDigest: await semanticDigest(input),
          controlReads: [
            { kind: 'session.execution_root', scope: 'session:current', revision: epoch },
          ],
        },
        requirements: [],
        freshness: { checked: true, source: decisionSource },
      });
    }
    async function prepare(action: 'use' | 'exit', epoch: string) {
      const id = `tool-${action}`;
      const input: Json = action === 'use' ? { action, path: '/linked' } : { action };
      await execution(`model-${action}`, 'model', {}, epoch);
      await store.finishExecution({
        ...owned,
        executionId: `model-${action}`,
        status: 'succeeded',
        result: {
          content: '',
          toolCalls: [{ id, name: 'git.worktree', arguments: JSON.stringify(input) }],
        },
      });
      await execution(id, 'tool', input, epoch, {
        kind: 'model_decision',
        modelExecutionId: `model-${action}`,
        toolBatchSize: 1,
      });
      return store.prepareSessionExecutionRoot({
        ...owned,
        sessionId: 'current',
        executionId: id,
        expectedEpoch: epoch,
        action,
        source: action === 'use' ? source : target,
        target: action === 'use' ? { ...target, requestedPath: '/linked' } : source,
      });
    }
    async function commit(action: 'use' | 'exit', binding: SessionExecutionRoot) {
      await store.finishExecution({
        ...owned,
        executionId: `tool-${action}`,
        status: 'succeeded',
        result: {
          outcome: 'succeeded',
          content: action,
          details: { action, cwdChanged: true, executionRoot: binding },
        } as unknown as Json,
      });
    }
    async function child(name: string) {
      const binding = await store.getSessionExecutionRoot({ sessionId: 'current' });
      const id = `parent-${name}`;
      await execution(id, 'tool', {}, binding.epoch, { executionRoot: binding } as unknown as Json);
      const operation = await store.ensureOperation({
        ...owned,
        sessionId: 'current',
        extensionId: 'fixture',
        originCommandId: 'start',
        parentExecutionId: id,
        operationKey: name,
        request: { kind: 'agent', configurationId: 'reviewer', input: { task: name } },
        childConfiguration: { id: 'reviewer', version: '1', snapshot: { modelId: 'fixed' } },
      });
      await store.finishExecution({
        ...owned,
        executionId: operation.executionId!,
        status: 'cancelled',
        result: {},
      });
      await store.finishExecution({ ...owned, executionId: id, status: 'succeeded', result: {} });
      return operation.childSessionId!;
    }
    const beforeChild = await child('before-use');
    const identity = async (id: string, reader = store) => {
      const session = (await reader.getSession(id))!;
      return {
        id: session.id,
        workspaceId: session.workspaceId,
        rootSessionId: session.rootSessionId,
        parentSessionId: session.parentSessionId,
      };
    };
    const identities = new Map<string, Awaited<ReturnType<typeof identity>>>();
    for (const id of ['current', 'other', 'linked-session', beforeChild])
      identities.set(id, await identity(id));
    const originalWorkspaces = (await store.listWorkspaceDirectory({ expectedStoreId })).items;
    const projection = new NativeDirectoryProjection();
    caller = directoryCaller(store, expectedStoreId);
    const attached = await caller.invoke({ method: 'attach' });
    if (!attached || !('generation' in attached)) throw Error('attach_failed');
    const generation = attached.generation;
    async function verify(
      reader = store,
      main = caller!,
      currentProjection = projection,
      currentGeneration = generation,
    ) {
      for (const [id, expected] of identities) expect(await identity(id, reader)).toEqual(expected);
      expect((await reader.listWorkspaceDirectory({ expectedStoreId })).items).toEqual(
        originalWorkspaces,
      );
      const inOriginal = await reader.listSessionDirectory({ ...base, workspaceId: 'original' });
      const inLinked = await reader.listSessionDirectory({ ...base, workspaceId: 'linked' });
      expect(inOriginal.items.map((item) => item.session.id)).toEqual(['current', 'other']);
      expect(inLinked.items.map((item) => item.session.id)).toEqual(['linked-session']);
      const result = await main.invoke({ method: 'directory', generation: currentGeneration });
      if (!result || !('workspaces' in result)) throw Error('directory_unavailable');
      const facts = result as NativeDirectory;
      expect(facts.unavailable).toBe(false);
      expect(facts.sessions.map((session) => session.id)).toEqual([
        'current',
        'other',
        'linked-session',
      ]);
      // The exact production grouping used at NativeDesktop's sidebar boundary.
      const workspaces = currentProjection.project(facts);
      expect(
        workspaces.map((workspace) => ({
          id: workspace.id,
          ids: workspace.sessions.map((session) => session.sessionId),
        })),
      ).toEqual([
        { id: 'original', ids: ['current', 'other'] },
        { id: 'linked', ids: ['linked-session'] },
      ]);
      const dom = new JSDOM(
        renderToStaticMarkup(
          <Sidebar
            workspaces={workspaces}
            selected="current"
            defaultExpanded
            actions={{}}
            connectionLabel=""
            onOpen={() => {}}
          />,
        ),
      );
      try {
        const groups = [...dom.window.document.querySelectorAll('section.workspace-group')];
        expect(
          groups.map((group) => group.querySelector('.space-row strong')?.textContent),
        ).toEqual(['Original space', 'Already registered linked space']);
        expect(groups[0]!.querySelectorAll('.session-row')).toHaveLength(2);
        expect(
          groups[0]!.querySelector('button[aria-current="page"]')?.getAttribute('aria-label'),
        ).toBe('current');
        expect(groups[1]!.querySelectorAll('.session-row')).toHaveLength(1);
        expect(groups[1]!.querySelector('.session-row')?.getAttribute('aria-label')).toBe(
          'linked-session',
        );
        expect(groups[1]!.querySelector('[aria-current="page"]')).toBeNull();
        expect(dom.window.document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      } finally {
        dom.window.close();
      }
    }
    await verify();
    const use = await prepare('use', '0');
    await verify(); // Reservation and its directory event cannot migrate the conversation.
    await commit('use', use);
    expect((await store.getSessionExecutionRoot({ sessionId: 'current' })).effectiveRootUri).toBe(
      target.rootUri,
    );
    await verify();
    const afterChild = await child('after-use');
    identities.set(afterChild, await identity(afterChild));
    expect(await identity(afterChild)).toEqual({
      id: afterChild,
      workspaceId: 'original',
      rootSessionId: 'current',
      parentSessionId: 'current',
    });
    expect((await store.getSessionExecutionRoot({ sessionId: afterChild })).effectiveRootUri).toBe(
      target.rootUri,
    );
    await verify(); // A new child stays in the original lineage, not the linked space's root list.
    const exit = await prepare('exit', '1');
    await verify();
    await commit('exit', exit);
    expect(await store.getSessionExecutionRoot({ sessionId: 'current' })).toMatchObject({
      epoch: '2',
      effectiveRootUri: source.rootUri,
    });
    expect((await store.getSessionExecutionRoot({ sessionId: beforeChild })).effectiveRootUri).toBe(
      source.rootUri,
    );
    expect((await store.getSessionExecutionRoot({ sessionId: afterChild })).effectiveRootUri).toBe(
      target.rootUri,
    );
    expect((await store.getSessionExecutionRoot({ sessionId: 'other' })).epoch).toBe('0');
    await verify();
    cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    coldCaller = directoryCaller(cold, expectedStoreId);
    const reopened = await coldCaller.invoke({ method: 'attach' });
    if (!reopened || !('generation' in reopened)) throw Error('cold_attach_failed');
    await verify(cold, coldCaller, new NativeDirectoryProjection(), reopened.generation);
  } finally {
    await coldCaller?.close();
    await caller?.close();
    await cold?.close();
    await store.close();
    removeTemporaryDirectory(directory);
  }
});
