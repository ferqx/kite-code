import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createKiteHomeArtifactStore,
  initializeKiteHomeStoreSchema,
  KiteHomeArtifactError,
  type KiteHomePrivateArtifactReference,
} from '../src';

function fixture() {
  const database = new Database(':memory:', { strict: true });
  initializeKiteHomeStoreSchema(database);
  return { database, store: createKiteHomeArtifactStore(database) };
}

function reference<Kind extends string>(
  kind: Kind,
  character: string,
  canonicalJson: string,
): KiteHomePrivateArtifactReference<Kind> {
  return Object.freeze({
    artifactId: `pa_${character.repeat(64)}`,
    kind,
    integrityIdentifier: `sha256:${character.repeat(64)}`,
    byteLength: Buffer.byteLength(canonicalJson, 'utf8'),
  });
}

describe('Kite Home typed Artifact Store', () => {
  test('content-addressed model publication retains its first time and rejects identity conflicts', () => {
    const { database, store } = fixture();
    try {
      const canonicalJson = '{"value":"first"}';
      const ref = reference('model_surface', 'a', canonicalJson);
      const input = { ref, artifactFormatVersion: 1, canonicalJson, createdAt: 10 };
      store.writeModel(input);
      store.writeModel({ ...input, createdAt: 20 });
      expect(
        database.query<{ created_at: number }, []>('SELECT created_at FROM model_artifacts').get()
          ?.created_at,
      ).toBe(10);
      for (const changed of [
        { ...input, canonicalJson: '{"value":"other"}' },
        { ...input, ref: { ...ref, kind: 'model_response' as const } },
        { ...input, ref: { ...ref, integrityIdentifier: `sha256:${'b'.repeat(64)}` } },
        { ...input, artifactFormatVersion: 2 },
      ]) {
        expect(() => store.writeModel({ ...changed, createdAt: 20 })).toThrow(
          KiteHomeArtifactError,
        );
      }
      expect(store.readModel(ref).canonicalJson).toBe(canonicalJson);
    } finally {
      database.close();
    }
  });

  test('roundtrips every dedicated Artifact domain without a generic table', () => {
    const { database, store } = fixture();
    try {
      const modelJson = '{"artifactFormatVersion":1,"response":"ok"}';
      const model = reference('model_response', 'a', modelJson);
      store.writeModel({
        ref: model,
        artifactFormatVersion: 1,
        canonicalJson: modelJson,
        createdAt: 1,
      });
      store.writeModel({
        ref: model,
        artifactFormatVersion: 1,
        canonicalJson: modelJson,
        createdAt: 20,
      });
      expect(store.readModel(model)).toEqual({
        artifactFormatVersion: 1,
        canonicalJson: modelJson,
      });

      const markdown = '# Plan\n';
      const plan = {
        artifactId: 'plan-1:v1',
        taskId: 'task-1',
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'structural-digest',
        byteLength: Buffer.byteLength(markdown, 'utf8'),
      } as const;
      store.writePlan({
        ref: plan,
        artifactFormatVersion: 1,
        planJson: '{"planId":"plan-1","version":1}',
        markdown,
        createdAt: 1,
      });
      expect(() =>
        store.writePlan({
          ref: plan,
          artifactFormatVersion: 1,
          planJson: '{"planId":"plan-1","version":1}',
          markdown,
          createdAt: 20,
        }),
      ).toThrow(KiteHomeArtifactError);
      expect(store.readPlan(plan)).toEqual({
        artifactFormatVersion: 1,
        planJson: '{"planId":"plan-1","version":1}',
        markdown,
      });

      const capabilityJson = '{"artifactFormatVersion":2,"result":{}}';
      const capability = reference('capability_result', 'b', capabilityJson);
      store.writeCapability({
        ref: capability,
        invocationId: 'invocation-1',
        evidenceDigest: 'evidence-digest',
        artifactFormatVersion: 2,
        canonicalJson: capabilityJson,
        createdAt: 1,
      });
      store.writeCapability({
        ref: capability,
        invocationId: 'invocation-1',
        evidenceDigest: 'evidence-digest',
        artifactFormatVersion: 2,
        canonicalJson: capabilityJson,
        createdAt: 20,
      });
      expect(store.readCapability(capability).invocationId).toBe('invocation-1');

      const preimageJson =
        '{"artifactFormatVersion":1,"invocationId":"invocation-1","operationDigest":"sha256:' +
        `${'1'.repeat(64)}","preimage":{},"targetIdentityDigest":"sha256:${'2'.repeat(64)}"}`;
      const preimage = reference('filesystem_preimage', '1', preimageJson);
      store.writeFilesystemPreimage({
        ref: preimage,
        invocationId: 'invocation-1',
        operationDigest: `sha256:${'1'.repeat(64)}`,
        targetIdentityDigest: `sha256:${'2'.repeat(64)}`,
        artifactFormatVersion: 1,
        canonicalJson: preimageJson,
        createdAt: 1,
      });
      store.writeFilesystemPreimage({
        ref: preimage,
        invocationId: 'invocation-1',
        operationDigest: `sha256:${'1'.repeat(64)}`,
        targetIdentityDigest: `sha256:${'2'.repeat(64)}`,
        artifactFormatVersion: 1,
        canonicalJson: preimageJson,
        createdAt: 20,
      });
      expect(store.readFilesystemPreimage(preimage).operationDigest).toBe(
        `sha256:${'1'.repeat(64)}`,
      );

      const sandboxJson = '{"artifactFormatVersion":1,"prepared":{}}';
      const sandbox = reference('sandbox_preparation', 'c', sandboxJson);
      store.writeSandboxPreparation({
        ref: sandbox,
        preparationDigest: 'preparation-digest',
        artifactFormatVersion: 1,
        canonicalJson: sandboxJson,
        expiresAtMs: 100,
        createdAt: 1,
      });
      store.writeSandboxPreparation({
        ref: sandbox,
        preparationDigest: 'preparation-digest',
        artifactFormatVersion: 1,
        canonicalJson: sandboxJson,
        expiresAtMs: 100,
        createdAt: 20,
      });
      expect(store.readSandboxPreparation(sandbox).preparationDigest).toBe('preparation-digest');

      const taskJson = '{"artifactFormatVersion":1,"task":"inspect"}';
      const task = reference('subagent_task', 'd', taskJson);
      store.writeSubagentTask({
        ref: task,
        artifactFormatVersion: 1,
        canonicalJson: taskJson,
        createdAt: 1,
      });
      store.writeSubagentTask({
        ref: task,
        artifactFormatVersion: 1,
        canonicalJson: taskJson,
        createdAt: 20,
      });
      expect(store.readSubagentTask(task).canonicalJson).toBe(taskJson);

      const resultJson =
        '{"artifactFormatVersion":1,"ownerKey":"session-owner","result":{"status":"completed","summary":"done"},"taskId":"child-1"}';
      const result = reference('subagent_task', '9', resultJson);
      store.writeSubagentTask({
        ref: result,
        artifactFormatVersion: 1,
        canonicalJson: resultJson,
        createdAt: 1,
      });
      store.writeSubagentTask({
        ref: result,
        artifactFormatVersion: 1,
        canonicalJson: resultJson,
        createdAt: 20,
      });
      expect(store.readSubagentTask(result).canonicalJson).toBe(resultJson);
      expect(store.findSubagentTaskResult('session-owner', 'child-1')).toEqual(result);
      expect(store.findSubagentTaskResult('other-owner', 'child-1')).toBeUndefined();
      expect(store.listSubagentTaskResults('session-owner')).toEqual([result]);

      const lifecycleJson = '{"artifactFormatVersion":1,"handle":{}}';
      const lifecycle = reference('subagent_handle', 'e', lifecycleJson);
      store.writeSubagentLifecycle({
        ref: lifecycle,
        artifactFormatVersion: 1,
        canonicalJson: lifecycleJson,
        createdAt: 1,
      });
      store.writeSubagentLifecycle({
        ref: lifecycle,
        artifactFormatVersion: 1,
        canonicalJson: lifecycleJson,
        createdAt: 20,
      });
      expect(store.readSubagentLifecycle(lifecycle).canonicalJson).toBe(lifecycleJson);

      const continuationJson = '{"artifactFormatVersion":1,"snapshot":{}}';
      const continuation = reference('subagent_continuation', 'f', continuationJson);
      store.writeSubagentContinuation({
        ref: continuation,
        artifactFormatVersion: 1,
        canonicalJson: continuationJson,
        createdAt: 1,
      });
      store.writeSubagentContinuation({
        ref: continuation,
        artifactFormatVersion: 1,
        canonicalJson: continuationJson,
        createdAt: 20,
      });
      expect(store.readSubagentContinuation(continuation).canonicalJson).toBe(continuationJson);

      const tables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%artifact%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(tables).not.toContain('runtime_artifacts');
      for (const table of [
        'model_artifacts',
        'capability_artifacts',
        'filesystem_preimage_artifacts',
        'sandbox_preparation_artifacts',
        'subagent_task_artifacts',
        'subagent_lifecycle_artifacts',
        'subagent_continuation_artifacts',
      ]) {
        const rows = database
          .query<{ created_at: number }, []>(`SELECT created_at FROM ${table}`)
          .all();
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.created_at === 1)).toBe(true);
      }
    } finally {
      database.close();
    }
  });

  test('makes exact retries idempotent and rejects identity conflicts', () => {
    const { database, store } = fixture();
    try {
      const firstJson = '{"artifactFormatVersion":1,"response":"aa"}';
      const ref = reference('model_response', 'a', firstJson);
      const input = {
        ref,
        artifactFormatVersion: 1,
        canonicalJson: firstJson,
        createdAt: 1,
      } as const;
      store.writeModel(input);
      store.writeModel(input);
      expect(
        database.query<{ count: number }, []>('SELECT count(*) AS count FROM model_artifacts').get()
          ?.count,
      ).toBe(1);

      const conflictingJson = '{"artifactFormatVersion":1,"response":"bb"}';
      expect(() =>
        store.writeModel({
          ...input,
          ref: {
            ...ref,
            byteLength: Buffer.byteLength(conflictingJson, 'utf8'),
          },
          canonicalJson: conflictingJson,
        }),
      ).toThrow(KiteHomeArtifactError);
      try {
        store.writeModel({
          ...input,
          ref: {
            ...ref,
            byteLength: Buffer.byteLength(conflictingJson, 'utf8'),
          },
          canonicalJson: conflictingJson,
        });
      } catch (error) {
        expect(error).toMatchObject({ code: 'artifact_conflict' });
      }

      const capabilityJson = '{"artifactFormatVersion":2,"result":{}}';
      store.writeCapability({
        ref: reference('capability_result', 'b', capabilityJson),
        invocationId: 'same-invocation',
        evidenceDigest: 'evidence-one',
        artifactFormatVersion: 2,
        canonicalJson: capabilityJson,
        createdAt: 1,
      });
      store.writeCapability({
        ref: reference('capability_result', 'c', capabilityJson),
        invocationId: 'same-invocation',
        evidenceDigest: 'evidence-two',
        artifactFormatVersion: 2,
        canonicalJson: capabilityJson,
        createdAt: 1,
      });
      expect(
        database
          .query<{ count: number }, []>('SELECT count(*) AS count FROM capability_artifacts')
          .get()?.count,
      ).toBe(2);
      expect(() =>
        store.writeCapability({
          ref: reference('capability_result', 'd', capabilityJson),
          invocationId: 'same-invocation',
          evidenceDigest: 'evidence-one',
          artifactFormatVersion: 2,
          canonicalJson: capabilityJson,
          createdAt: 1,
        }),
      ).toThrow(KiteHomeArtifactError);
      try {
        store.writeCapability({
          ref: reference('capability_result', 'd', capabilityJson),
          invocationId: 'same-invocation',
          evidenceDigest: 'evidence-one',
          artifactFormatVersion: 2,
          canonicalJson: capabilityJson,
          createdAt: 1,
        });
      } catch (error) {
        expect(error).toMatchObject({ code: 'artifact_conflict' });
      }
    } finally {
      database.close();
    }
  });

  test('fails closed when a reference does not match the stored row', () => {
    const { database, store } = fixture();
    try {
      const canonicalJson = '{"artifactFormatVersion":1,"response":"ok"}';
      const ref = reference('model_response', 'a', canonicalJson);
      store.writeModel({
        ref,
        artifactFormatVersion: 1,
        canonicalJson,
        createdAt: 1,
      });
      expect(() =>
        store.readModel({
          ...ref,
          integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        }),
      ).toThrow(KiteHomeArtifactError);
      try {
        store.readModel({
          ...ref,
          integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        });
      } catch (error) {
        expect(error).toMatchObject({ code: 'artifact_corrupt' });
      }
      const missing = reference('model_response', 'c', canonicalJson);
      expect(() => store.readModel(missing)).toThrow(KiteHomeArtifactError);
    } finally {
      database.close();
    }
  });

  test('requires complete reachability before domain-local garbage collection', () => {
    const { database, store } = fixture();
    try {
      const firstJson = '{"artifactFormatVersion":1,"response":"first"}';
      const secondJson = '{"artifactFormatVersion":1,"response":"second"}';
      const first = reference('model_response', 'a', firstJson);
      const second = reference('model_response', 'b', secondJson);
      store.writeModel({
        ref: first,
        artifactFormatVersion: 1,
        canonicalJson: firstJson,
        createdAt: 1,
      });
      store.writeModel({
        ref: second,
        artifactFormatVersion: 1,
        canonicalJson: secondJson,
        createdAt: 1,
      });
      expect(() =>
        store.collectModelGarbage({
          complete: false,
          reachableArtifactIds: [first.artifactId],
          createdBeforeOrAt: 10,
        }),
      ).toThrow(KiteHomeArtifactError);
      const result = store.collectModelGarbage({
        complete: true,
        reachableArtifactIds: [first.artifactId],
        createdBeforeOrAt: 10,
      });
      expect(result).toEqual({ retainedArtifacts: 1, deletedArtifacts: 1 });
      expect(store.readModel(first).canonicalJson).toBe(firstJson);
      expect(() => store.readModel(second)).toThrow();
    } finally {
      database.close();
    }
  });
});
