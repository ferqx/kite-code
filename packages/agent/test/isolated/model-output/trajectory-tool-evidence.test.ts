import { rmSync } from 'node:fs';
import type { TrajectoryEvent } from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

test('Tool parameters, complete body and formally published image/PDF checkpoints stay exact without executing a Model or Tool', async () => {
  const dataRoot = temporaryDirectory('kite-tool-trajectory-'),
    profile = { dataRoot, profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const artifacts = createArtifactStore({ profile, store });
  const runtime = createRuntime({
    store,
    artifacts,
    model: {
      stream() {
        throw Error('Reader must never call Model');
      },
    },
    permissions: {
      async authorize() {
        throw Error('Reader must never request dispatch');
      },
    },
  });
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS6sAAAAASUVORK5CYII=',
    'base64',
  );
  const pdf = Buffer.from('%PDF-1.4\noriginal public PDF\n%%EOF');
  const completeBody = 'EXACT_PUBLIC_BODY 雪\n'.repeat(10000);
  const scope = { storeId, sessionId: 's', subjectId: 'owner' };
  try {
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: 'file:///fixture',
      name: 'w',
    });
    await store.createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'create',
      workspaceId: 'w',
      title: 'test',
    });
    await store.acceptCommand({
      expectedStoreId: storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'work' },
    });
    const owner = (await store.acquireSessionOwner('s', 'test'))!,
      write = { expectedStoreId: storeId, owner };
    const run = await store.startRun({
      ...write,
      commandId: 'work',
      configuration: { tools: [{ id: 'capture', version: '1', extensionId: 'fixture.capture' }] },
    });
    const input = { mode: 'original', empty: null },
      source = { kind: 'model_decision', modelExecutionId: 'original-decision' };
    await store.planExecution({
      ...write,
      executionId: 'capture',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      stepId: 'step',
      callId: 'call',
      kind: 'tool',
      definitionId: 'capture',
      definitionVersion: '1',
      input,
      decisionSource: source,
    });
    await store.markDispatching({
      ...write,
      executionId: 'capture',
      requirements: [],
      freshness: { checked: true, source },
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest(input),
      },
    });
    const artifactScope = { kind: 'execution' as const, id: 'capture' };
    const publish = (refId: string, content: Uint8Array, mediaType: string) =>
      artifacts.publish({
        expectedStoreId: storeId,
        sessionId: 's',
        subjectId: 'owner',
        scope: artifactScope,
        refId,
        content,
        mediaType,
      });
    const png = await publish('formal-image', image, 'image/png'),
      document = await publish('formal-pdf', pdf, 'application/pdf'),
      text = await publish('complete-body', Buffer.from(completeBody), 'text/plain');
    const privateBody = await publish(
      'model-output-private',
      Buffer.from('PRIVATE_MODEL_ENVELOPE'),
      'application/vnd.kite.model-output+json',
    );
    const ref = (item: typeof png) => ({
      id: item.id,
      size: item.size,
      mediaType: item.mediaType,
      scope: artifactScope,
    });
    await store.finishExecution({
      ...write,
      executionId: 'capture',
      status: 'succeeded',
      result: {
        outcome: 'succeeded',
        content: 'original preview',
        artifactRefs: [
          ref(png),
          ref(document),
          ref(privateBody),
          { ...ref(png), id: 'unverified-reference' },
          { ...ref(document), size: '999' },
        ],
        modelImages: [ref(png)],
        modelContent: { kind: 'artifact', reference: ref(text), encoding: 'utf-8' },
        details: { PRIVATE_DIAGNOSTIC: 'NEVER_PUBLIC' },
      },
    });
    const upperCursor = (await store.getMetadata()).lastChangeCursor;
    const events: TrajectoryEvent[] = [];
    let afterCursor = '0';
    for (;;) {
      const page = await store.readTrajectoryEvents({ ...scope, upperCursor, afterCursor });
      events.push(...page.events);
      if (page.exhausted) break;
      afterCursor = page.scannedThrough;
    }
    const event = events
      .filter((event) => event.kind === 'tool' && event.recordedStatus === 'succeeded')
      .at(-1)!;
    expect(event).toBeDefined();
    const read = (kind: TrajectoryEvent['evidenceRefs'][number]['kind'], index = 0) => {
      const original = event.evidenceRefs.filter((ref) => ref.kind === kind)[index]!;
      return runtime.readTrajectoryEvidence({
        ...scope,
        upperCursor,
        atCursor: event.sequence,
        eventId: event.eventId,
        evidenceId: original.evidenceId,
        contentVersion: original.contentVersion,
        signal: AbortSignal.timeout(3000),
      });
    };
    expect(JSON.parse(Buffer.from((await read('tool_input')).content).toString())).toEqual(input);
    expect(JSON.parse(Buffer.from((await read('tool_result')).content).toString())).toEqual({
      outcome: 'succeeded',
      content: completeBody,
    });
    expect(event.evidenceRefs.filter((ref) => ref.kind === 'artifact')).toHaveLength(2);
    expect(Buffer.from((await read('artifact', 0)).content)).toEqual(image);
    expect(Buffer.from((await read('artifact', 1)).content)).toEqual(pdf);
    expect((await read('artifact', 0)).mediaType).toBe('image/png');
    const first = event.evidenceRefs.find((ref) => ref.kind === 'artifact')!;
    let denied: unknown;
    try {
      await runtime.readTrajectoryEvidence({
        ...scope,
        subjectId: 'stranger',
        upperCursor,
        atCursor: event.sequence,
        eventId: event.eventId,
        evidenceId: first.evidenceId,
        contentVersion: first.contentVersion,
      });
    } catch (error) {
      denied = error;
    }
    expect(denied).toMatchObject({ code: 'trajectory_scope_denied' });
    expect((await store.getMetadata()).lastChangeCursor).toBe(upperCursor);
  } finally {
    await runtime.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
