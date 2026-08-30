import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { FilesystemPreimageArtifactStore } from '@kite-ai/builtin-runtime/filesystem';
import { PrivateImmutableArtifactStorage } from '@kite-ai/builtin-runtime/model';
import { createBuiltinPlanDocument, PlanArtifactStore } from '@kite-ai/builtin-runtime/planning';
import {
  createKiteHomeArtifactStore,
  initializeKiteHomeStoreSchema,
} from '@kite-ai/runtime-storage-sqlite';
import { createKiteHomeBuiltinArtifactBackends } from '../src/bootstrap/kite-home-artifact-backends';

describe('Store 9 Builtin Artifact adapters', () => {
  test('keeps model, Plan and filesystem preimage bodies in dedicated DB tables', () => {
    const database = new Database(':memory:', { strict: true });
    initializeKiteHomeStoreSchema(database);
    const backends = createKiteHomeBuiltinArtifactBackends(
      createKiteHomeArtifactStore(database),
      () => 10,
    );
    try {
      const model = new PrivateImmutableArtifactStorage({
        backend: backends.model,
        namespace: 'model-artifacts',
        partitions: [
          {
            kind: 'model_response',
            directory: 'responses',
            extension: '.json',
          },
        ],
        maxArtifactBytes: 16 * 1024 * 1024,
      });
      const modelJson = '{"artifactFormatVersion":1,"response":"stored"}';
      const modelRef = model.write('model_response', Buffer.from(modelJson, 'utf8'));
      expect(new TextDecoder().decode(model.read(modelRef))).toBe(modelJson);

      const plan = createBuiltinPlanDocument({
        taskId: 'task-db-artifact',
        turnId: 'turn-1',
        title: 'Persist the Plan in Store 9',
        bodyMarkdown: 'Keep the immutable Plan body in its dedicated typed table.',
        steps: [{ id: 'persist', title: 'Persist and read the Plan' }],
      });
      const plans = new PlanArtifactStore({ backend: backends.plan });
      const planRef = plans.write('task-db-artifact', plan);
      expect(planRef.displayPath).toStartWith('kite.sqlite#plans/');
      expect(plans.read(planRef).plan).toEqual(plan);

      const content = 'private preimage';
      const bytes = Buffer.from(content, 'utf8');
      const preimages = new FilesystemPreimageArtifactStore({
        backend: backends.filesystemPreimage,
      });
      const preimageRef = preimages.write({
        invocationId: 'invocation-1',
        operationDigest: `sha256:${'1'.repeat(64)}`,
        targetIdentityDigest: `sha256:${'2'.repeat(64)}`,
        preimage: {
          existed: true,
          content,
          contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          byteLength: bytes.byteLength,
        },
      });
      expect(preimages.read(preimageRef).preimage.content).toBe(content);

      expect(
        database.query<{ count: number }, []>('SELECT count(*) AS count FROM model_artifacts').get()
          ?.count,
      ).toBe(1);
      expect(
        database.query<{ count: number }, []>('SELECT count(*) AS count FROM plan_artifacts').get()
          ?.count,
      ).toBe(1);
      expect(
        database
          .query<{ count: number }, []>(
            'SELECT count(*) AS count FROM filesystem_preimage_artifacts',
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });
});
