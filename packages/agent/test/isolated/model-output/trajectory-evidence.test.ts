import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAdapter } from '@kite-ai/ai';
import type { TrajectoryEvent } from '@kite-ai/trajectory';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

async function rejectionCode(read: Promise<unknown>) {
  try {
    await read;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

test('actual streaming Model Evidence keeps sealed public views while private transport Artifacts remain redacted', async () => {
  const dataRoot = temporaryDirectory('kite-trajectory-model-evidence-'),
    profile = { dataRoot, profile: 'test' };
  const originalStore = await openSqliteStore(profile),
    storeId = (await originalStore.getMetadata()).storeId;
  let release!: () => void, checkpoint!: (cursor: string) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstCheckpoint = new Promise<string>((resolve) => {
    checkpoint = resolve;
  });
  let recorded = false,
    calls = 0;
  const store = new Proxy(originalStore, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'persistModelPartial')
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args);
          if (!recorded) {
            recorded = true;
            checkpoint((await target.getMetadata()).lastChangeCursor);
          }
          return result;
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Store;
  const prefix = `${'prefix-'.repeat(16000)}😀`,
    tail = 'LATER_COMPLETE_TAIL';
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      for (let offset = 0; offset < prefix.length; offset += 32768)
        yield { type: 'text_delta', text: prefix.slice(offset, offset + 32768) };
      await gate;
      yield { type: 'text_delta', text: tail };
      yield {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
        continuation: { PRIVATE_OPAQUE: 'NEVER_PUBLIC' },
      };
    },
  };
  const artifacts = createArtifactStore({ store, profile });
  const runtime = createRuntime({
    store,
    model,
    artifacts,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  const originalScope = { expectedStoreId: storeId, sessionId: 's', subjectId: 'actor' },
    scope = { storeId, sessionId: 's', subjectId: 'actor' };
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${join(dataRoot, 'workspace')}`,
      name: 'fixture',
    });
    await runtime.createSession({
      ...originalScope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'fixture',
    });
    await runtime.submitCommand({
      ...originalScope,
      commandId: 'work',
      request: { kind: 'run.start', content: 'original-model-input-'.repeat(5000) },
    });
    const upperCursor = await firstCheckpoint;
    const page = await store.readTrajectoryEvents({ ...scope, afterCursor: '0', upperCursor });
    const event = page.events
      .filter((event) => event.kind === 'message' && event.attributes.role === 'assistant')
      .at(-1)!;
    const inputEvent = page.events
      .filter(
        (event) =>
          event.kind === 'model' && event.evidenceRefs.some((ref) => ref.kind === 'model_input'),
      )
      .at(-1)!;
    const inputRef = inputEvent.evidenceRefs.find((ref) => ref.kind === 'model_input')!,
      outputRef = event.evidenceRefs.find((ref) => ref.kind === 'message')!;
    const evidence = (ref: typeof inputRef, source = event) => ({
      ...scope,
      upperCursor,
      atCursor: source.sequence,
      eventId: source.eventId,
      evidenceId: ref.evidenceId,
      contentVersion: ref.contentVersion,
    });
    const before = await runtime.readTrajectoryEvidence(evidence(outputRef));
    const saved = JSON.parse(Buffer.from(before.content).toString('utf8'));
    expect(saved).toMatchObject({ role: 'assistant', status: 'incomplete', attachments: [] });
    expect(prefix.startsWith(saved.content)).toBe(true);
    expect(saved.content.length).toBeGreaterThan(4096);
    release();
    await runtime.waitForCommand('work', { timeoutMs: 10000 });
    const latest = await runtime.readModelOutput({
      ...originalScope,
      executionId: event.executionId!,
    });
    expect(latest.output.content).toBe(prefix + tail);
    const completeCursor = (await store.getMetadata()).lastChangeCursor;
    const completePage = await store.readTrajectoryEvents({
      ...scope,
      afterCursor: '0',
      upperCursor: completeCursor,
    });
    const completeMessage = completePage.events
      .filter(
        (value) =>
          value.kind === 'message' &&
          value.executionId === event.executionId &&
          value.attributes.status === 'complete',
      )
      .at(-1)!;
    const completeRef = completeMessage.evidenceRefs.find((value) => value.kind === 'message')!;
    const completeView = await runtime.readTrajectoryEvidence({
      ...scope,
      upperCursor: completeCursor,
      atCursor: completeMessage.sequence,
      eventId: completeMessage.eventId,
      evidenceId: completeRef.evidenceId,
      contentVersion: completeRef.contentVersion,
    });
    expect(JSON.parse(Buffer.from(completeView.content).toString())).toEqual({
      role: 'assistant',
      status: 'complete',
      content: prefix + tail,
      attachments: [],
    });
    expect(
      completePage.events.some(
        (value) =>
          value.kind === 'model' &&
          value.executionId === event.executionId &&
          value.evidenceRefs.some((ref) => ref.kind === 'model_output'),
      ),
    ).toBe(true);
    const cursorBeforeRead = (await store.getMetadata()).lastChangeCursor;
    const after = await runtime.readTrajectoryEvidence(evidence(outputRef));
    expect(after.content).toEqual(before.content);
    expect(after.availability).toBe('partial');
    expect(Buffer.from(after.content).toString()).not.toContain(tail);
    expect(Buffer.from(after.content).toString()).not.toContain('NEVER_PUBLIC');
    const requestView = await runtime.readTrajectoryEvidence(evidence(inputRef, inputEvent));
    expect(requestView.availability).toBe('available');
    const currentRequest = await runtime.readModelInput({
      ...originalScope,
      executionId: event.executionId!,
    });
    expect(JSON.parse(Buffer.from(requestView.content).toString()).request).toEqual(
      currentRequest.request,
    );
    expect(Buffer.from(requestView.content).toString()).not.toContain(
      'authorizationCheckBindingDigest',
    );
    const abort = new AbortController();
    abort.abort(new Error('evidence cancellation'));
    let cancelled: unknown;
    try {
      await runtime.readTrajectoryEvidence({ ...evidence(outputRef), signal: abort.signal });
    } catch (error) {
      cancelled = error;
    }
    expect((cancelled as Error).message).toBe('evidence cancellation');
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursorBeforeRead);
    expect(calls).toBe(1);

    const publicBytes = Buffer.from('ordinary public Artifact bytes 😀');
    const publicArtifact = await artifacts.publish({
      ...originalScope,
      refId: 'ordinary-public-result',
      scope: { kind: 'session', id: 's' },
      mediaType: 'text/plain',
      content: publicBytes,
    });
    const artifactUpper = (await store.getMetadata()).lastChangeCursor;
    const events: TrajectoryEvent[] = [];
    let afterCursor = '0';
    for (;;) {
      const page = await store.readTrajectoryEvents({
        ...scope,
        afterCursor,
        upperCursor: artifactUpper,
      });
      events.push(...page.events);
      if (page.exhausted) break;
      expect(BigInt(page.scannedThrough)).toBeGreaterThan(BigInt(afterCursor));
      afterCursor = page.scannedThrough;
    }
    const privateArtifacts = events.filter(
      (value) =>
        value.kind === 'artifact' &&
        /^(model-body-|model-output-)/.test(value.attributes.artifactId),
    );
    expect(
      privateArtifacts.some(
        (value) =>
          value.kind === 'artifact' && value.attributes.artifactId.startsWith('model-body-'),
      ),
    ).toBe(true);
    expect(
      privateArtifacts.some(
        (value) =>
          value.kind === 'artifact' && value.attributes.artifactId.startsWith('model-output-'),
      ),
    ).toBe(true);
    for (const privateArtifact of privateArtifacts) {
      if (privateArtifact.kind !== 'artifact') throw Error('expected original Artifact event');
      expect(privateArtifact.sourceEventType).toBe('artifact.published');
      expect(privateArtifact.evidenceRefs).toHaveLength(1);
      const ref = privateArtifact.evidenceRefs[0]!;
      expect(ref).toMatchObject({ kind: 'artifact', availability: 'redacted' });
      const input = {
        ...scope,
        upperCursor: artifactUpper,
        atCursor: privateArtifact.sequence,
        eventId: privateArtifact.eventId,
        evidenceId: ref.evidenceId,
        contentVersion: ref.contentVersion,
      };
      expect(await rejectionCode(store.readTrajectoryBinding(input))).toBe(
        'trajectory_evidence_unavailable',
      );
      expect(await rejectionCode(runtime.readTrajectoryEvidence(input))).toBe(
        'trajectory_evidence_unavailable',
      );
      expect(
        await rejectionCode(
          runtime.readArtifact({
            ...originalScope,
            refId: privateArtifact.attributes.artifactId,
            scope: privateArtifact.attributes.artifactId.startsWith('model-body-')
              ? { kind: 'session', id: 's' }
              : { kind: 'execution', id: event.executionId! },
          }),
        ),
      ).toBe('artifact_scope_denied');
    }
    const publicEvent = events.find(
      (value) => value.kind === 'artifact' && value.attributes.artifactId === publicArtifact.id,
    )!;
    const publicRef = publicEvent.evidenceRefs[0]!;
    expect(publicRef).toMatchObject({ kind: 'artifact', availability: 'available' });
    const publicInput = {
      ...scope,
      upperCursor: artifactUpper,
      atCursor: publicEvent.sequence,
      eventId: publicEvent.eventId,
      evidenceId: publicRef.evidenceId,
      contentVersion: publicRef.contentVersion,
    };
    expect((await store.readTrajectoryBinding(publicInput)).binding.kind).toBe('artifact');
    const publicEvidence = await runtime.readTrajectoryEvidence(publicInput);
    expect(publicEvidence.availability).toBe('available');
    expect(publicEvidence.content).toEqual(publicBytes);
    expect(
      (
        await runtime.readArtifact({
          ...originalScope,
          refId: publicArtifact.id,
          scope: publicArtifact.scope,
        })
      ).content,
    ).toEqual(publicBytes);
    expect((await runtime.readTrajectoryEvidence(evidence(outputRef))).content).toEqual(
      before.content,
    );
    expect((await runtime.readTrajectoryEvidence(evidence(inputRef, inputEvent))).content).toEqual(
      requestView.content,
    );
    expect((await store.getMetadata()).lastChangeCursor).toBe(artifactUpper);
    expect(calls).toBe(1);
  } finally {
    release();
    await runtime.close();
    await store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 15000);
