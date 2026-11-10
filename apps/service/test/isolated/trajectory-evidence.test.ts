import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient, readTrajectoryEvidence } from '@kite-ai/client';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createTrajectorySource } from '../../src/trajectory';

test('typed material passes bounded authenticated view chunks and revocation stops an existing lease', async () => {
  const root = temporaryDirectory('kite-evidence-http-');
  chmodSync(root, 0o700);
  const profile = { dataRoot: root, profile: 'test' },
    store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const text = 'original output 雪😀'.repeat(8000);
  const model = createFixedModel([
    [
      { type: 'text_delta', text },
      {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
        continuation: { PRIVATE_OPAQUE: 'NEVER_PUBLIC' },
      },
    ],
  ]);
  const runtime = createRuntime({
    store,
    model,
    artifacts: createArtifactStore({ store, profile }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: root, name: 'test', accessKey: 'fixture' },
    buildId: 'evidence',
    subjectId: 'actor',
    trajectory: createTrajectorySource(store, (input) => runtime.readTrajectoryEvidence(input)),
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['trajectory', 'trajectory_evidence'],
    },
  });
  const db = new Database(join(root, 'test', 'core.db'));
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'fixture',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'fixture',
      subjectId: 'actor',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'actor',
      request: { kind: 'run.start', content: 'fixture' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 10000 });
    await client.connect();
    const snapshot = await client.openTrajectory({
      storeId,
      sessionId: 's',
      eventKinds: ['model'],
    });
    const page = await client.readTrajectoryEvents({
      storeId,
      sessionId: 's',
      eventKinds: ['model'],
      afterCursor: '0',
      upperCursor: snapshot.upperCursor,
    });
    const event = page.events
      .filter((item) => item.sourceEventType === 'execution.finished')
      .at(-1)!;
    const ref = event.evidenceRefs.find((item) => item.kind === 'model_output')!;
    const input = {
      storeId,
      sessionId: 's',
      upperCursor: snapshot.upperCursor,
      atCursor: event.sequence,
      eventId: event.eventId,
      evidenceId: ref.evidenceId,
      contentVersion: ref.contentVersion,
    };
    const before = await store.getMetadata(),
      calls = model.requests.length;
    const full = await readTrajectoryEvidence(client, input);
    expect(JSON.parse(new TextDecoder().decode(full.content))).toEqual({
      content: text,
      reasoning: '',
      toolCalls: [],
      complete: true,
    });
    expect(new TextDecoder().decode(full.content)).not.toContain('NEVER_PUBLIC');
    expect(full.descriptor.viewSha256).not.toBe(ref.contentVersion);
    expect(full.descriptor.transformation).toBe('kite.model-output-public@1');
    const descriptor = await client.openTrajectoryEvidence(input);
    await expect(
      client.readTrajectoryEvidenceChunk({
        storeId,
        sessionId: 'other',
        readId: descriptor.readId,
        offset: '0',
      }),
    ).rejects.toMatchObject({ code: 'trajectory_evidence_read_missing' });
    const first = await client.readTrajectoryEvidenceChunk({
      storeId,
      sessionId: 's',
      readId: descriptor.readId,
      offset: '0',
      limit: 65536,
    });
    expect(Buffer.from(first.data, 'base64').byteLength).toBe(65536);
    expect(first.nextOffset).toBe('65536');
    expect(first.eof).toBe(false);
    db.run("UPDATE command SET subject_id='other-actor' WHERE id='create'");
    await expect(
      client.readTrajectoryEvidenceChunk({
        storeId,
        sessionId: 's',
        readId: descriptor.readId,
        offset: first.nextOffset,
      }),
    ).rejects.toMatchObject({ code: 'trajectory_scope_denied', status: 403 });
    await client.closeTrajectoryEvidence({ storeId, sessionId: 's', readId: descriptor.readId });
    expect(model.requests).toHaveLength(calls);
    expect(await store.getMetadata()).toEqual(before);
  } finally {
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
