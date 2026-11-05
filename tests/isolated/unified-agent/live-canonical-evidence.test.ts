import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { ModelAttemptError, type ModelRequest } from '@kite-ai/ai';
import { saveLiveCanonicalModelEvidence } from '../../e2e/live/model/live-canonical-evidence';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../fixtures/test-filesystem';

const prefix = 'real-partial-output-'.repeat(7000);
const final = 'The controlled local response completed.';
type Mode = 'normal' | 'retry' | 'zero-event-failed' | 'cancelled' | 'active';
type Record = {
  execution: { id: string; status: string; result: { content: string } };
  input?: unknown;
  output?: Awaited<ReturnType<ReturnType<typeof createRuntime>['readModelOutput']>>;
  inspectorUnavailable?: boolean;
};

async function fixture(mode: Mode) {
  const root = temporaryDirectory('kite-live-canonical-');
  const workspace = join(root, 'workspace');
  privateDirectory(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'state'), profile: 'test' });
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const requests: ModelRequest[] = [];
  let resumed!: () => void;
  const prefixPersisted = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned-local-test' }) },
    model: {
      async *stream(request, context) {
        requests.push(structuredClone(request));
        if (mode === 'zero-event-failed') throw new Error('controlled-before-response');
        if (requests.length === 1 && mode !== 'normal') {
          yield { type: 'text_delta', text: prefix };
          if (mode === 'retry') throw new ModelAttemptError('stream_incomplete');
          // The Runtime persisted the yielded prefix before requesting this next step.
          resumed();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(context.signal.reason);
            context.signal.addEventListener('abort', abort, { once: true });
            if (context.signal.aborted) abort();
          });
          return;
        }
        yield { type: 'text_delta', text: final };
        yield {
          type: 'finish',
          reason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });
  const identity = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
  const cancel = () =>
    runtime.cancelCommand({
      ...identity,
      commandId: 'stop',
      targetCommandId: 'work',
    });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned local canonical evidence',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Original model output evidence',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Return the controlled local response.' },
    });
    if (mode === 'active' || mode === 'cancelled') await prefixPersisted;
    if (mode === 'cancelled') await cancel();
    if (mode !== 'active') await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const models = (await store.listExecutions('s')).filter((row) => row.kind === 'model');
    return {
      runtime,
      store,
      requests,
      models,
      identity,
      async archive(captured = requests) {
        const result = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          requests: captured,
          root,
          subjectId: 'owner',
          verifyRequests: true,
        });
        const body = readFileSync(join(root, result.file));
        expect(createHash('sha256').update(body).digest('hex')).toBe(result.sha256);
        return { result, records: JSON.parse(body.toString()) as Record[] };
      },
      async close() {
        if (mode === 'active') {
          await cancel();
          await runtime.waitForCommand('work', { timeoutMs: 5000 });
        }
        await runtime.close();
        await store.close();
        removeTemporaryDirectory(root);
      },
    };
  } catch (error) {
    await runtime.close();
    await store.close();
    removeTemporaryDirectory(root);
    throw error;
  }
}

test('retry archives the complete persisted failed prefix without declaring the Provider response complete', async () => {
  const f = await fixture('retry');
  try {
    expect(f.models.map((row) => row.status)).toEqual(['failed', 'succeeded']);
    const original = await f.runtime.readModelOutput({
      ...f.identity,
      executionId: f.models[0]!.id,
    });
    expect(original.output.content).toBe(prefix);
    expect(original.output.complete).toBe(false);
    const { result, records } = await f.archive();
    expect(result.complete).toBe(true);
    expect(result.requestIdentity?.matches).toBe(true);
    expect(records).toHaveLength(2);
    expect(records[0]!.output).toEqual(original);
    expect(records[0]!.output?.output.content).toHaveLength(140000);
    expect(records[1]!.output?.output).toMatchObject({ content: final, complete: true });
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const mode of ['zero-event-failed', 'cancelled', 'active', 'normal'] as const)
  test(`archive preserves the original inspector's ${mode} output and its completeness`, async () => {
    const f = await fixture(mode);
    try {
      const original = await f.runtime.readModelOutput({
        ...f.identity,
        executionId: f.models[0]!.id,
      });
      const { result, records } = await f.archive();
      expect(result.complete).toBe(mode !== 'active');
      expect(result.requestIdentity?.matches).toBe(true);
      expect(records).toHaveLength(1);
      expect(records[0]!.output).toEqual(original);
      expect(records[0]!.output?.output).toMatchObject({
        content: mode === 'normal' ? final : mode === 'zero-event-failed' ? '' : prefix,
        complete: mode === 'normal',
      });
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

for (const mode of ['normal', 'zero-event-failed'] as const)
  test(`output inspection failure cannot be hidden by a matching ${mode} request`, async () => {
    const f = await fixture(mode);
    try {
      f.runtime.readModelOutput = async () => {
        throw new Error('private-inspector-error-do-not-export');
      };
      const { result, records } = await f.archive();
      expect(result.complete).toBe(false);
      expect(result.requestIdentity?.matches).toBe(true);
      expect(records[0]!.inspectorUnavailable).toBe(true);
      expect(records[0]!.output).toBeUndefined();
      expect(JSON.stringify(records)).not.toContain('private-inspector-error');
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test('input inspection failure remains unavailable without a fabricated output', async () => {
  const f = await fixture('normal');
  try {
    f.runtime.readModelInput = async () => {
      throw new Error('private-input-error-do-not-export');
    };
    const { result, records } = await f.archive();
    expect(result.complete).toBe(false);
    expect(result.requestIdentity?.matches).toBe(false);
    expect(records[0]!.inspectorUnavailable).toBe(true);
    expect(records[0]!.input).toBeUndefined();
    expect(records[0]!.output).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain('private-input-error');
  } finally {
    await f.close();
  }
});

test('a changed captured request does not pass identity verification even when original output is readable', async () => {
  const f = await fixture('normal');
  try {
    const changed = structuredClone(f.requests);
    changed[0] = {
      ...changed[0]!,
      messages: changed[0]!.messages.map((message, index) =>
        index === 0 ? { ...message, content: 'Changed after dispatch.' } : message,
      ),
    };
    const { result, records } = await f.archive(changed);
    expect(result.complete).toBe(false);
    expect(result.requestIdentity?.matches).toBe(false);
    expect(records[0]!.output?.output).toMatchObject({ content: final, complete: true });
    expect(f.requests[0]!.messages[0]!.content).not.toBe('Changed after dispatch.');
  } finally {
    await f.close();
  }
});
