import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ActionContext,
  type ArtifactRef,
  defineExtension,
  type Extension,
  type JobHandle,
  type Json,
  type JsonSchema,
  type OperationRef,
  type PublicView,
  type ToolContext,
} from '@kite-ai/agent/extensions';

export const capsuleId = 'fixture.unseen-capsule';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: Json) => value as Record<string, Json>;
const inputSchema: JsonSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 64 },
    payload: { type: 'string', maxLength: 100000 },
    hold: { type: 'boolean' },
  },
  required: ['key', 'payload'],
  additionalProperties: false,
};
const keySchema: JsonSchema = {
  type: 'object',
  properties: { key: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 64 } },
  required: ['key'],
  additionalProperties: false,
};
const requestKey = (key: string) => `capsule/${key}/request`;
const resultKey = (key: string) => `capsule/${key}/result`;
const type = (part: string) => `${capsuleId}.${part}`;

export function createCapsule(options: {
  root: string;
  workerPath: string;
  nodePath: string;
  missingCondition?: boolean;
}) {
  const live = new Map<
    string,
    { child: ChildProcess; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }
  >();
  let starts = 0,
    cancels = 0;
  const launch = async (input: Json, context: ActionContext, required = false) => {
    const values = object(input),
      key = String(values.key),
      payload = String(values.payload);
    const existing = await context.records.get(requestKey(key));
    if (existing) {
      if (object(existing.value).sourceDigest !== digest(payload))
        throw Error('capsule_identity_conflict');
      const operation = await context.records.get(`capsule/${key}/operation`);
      if (!operation) throw Error('capsule_original_receipt_unverifiable');
      return object(operation.value).ref as unknown as OperationRef;
    }
    const artifact = await context.artifacts!.publish({
      key: `capsule-${key}-input`,
      content: Buffer.from(payload),
      mediaType: 'text/plain',
    });
    writeFileSync(join(options.root, `${key}.request`), JSON.stringify({ payload, hold: true }), {
      mode: 0o600,
      flag: 'wx',
    });
    const jobInput: Json = { key, sourceDigest: digest(payload) };
    const plan = await context.records.write({
      key: requestKey(key),
      expectedRevision: null,
      contentType: type('request'),
      contentVersion: 1,
      executable: true,
      value: {
        key,
        sourceDigest: digest(payload),
        sourceArtifact: artifact as unknown as Json,
        jobInput,
        ref: null,
      },
    });
    if (required) {
      const tool = context as ToolContext;
      if (!tool.runId || !tool.requirements) throw Error('actual_run_required');
      await tool.requirements.register([
        {
          definitionVersion: '1',
          requirementId: `capsule-${key}`,
          recordKey: plan.key,
          revision: plan.revision,
          phase: 'completion',
        },
      ]);
    }
    const ref = await context.operations.ensure({
      key: `capsule-${key}`,
      planRecordKey: plan.key,
      cancellation: required ? 'attached' : 'detached',
      request: {
        kind: 'job',
        definitionId: `${capsuleId}.pack`,
        definitionVersion: '1',
        input: jobInput,
      },
    });
    await context.records.write({
      key: `capsule/${key}/operation`,
      expectedRevision: null,
      contentType: type('operation'),
      contentVersion: 1,
      executable: true,
      value: { key, ref: ref as unknown as Json, sourceDigest: digest(payload) },
    });
    if (values.hold !== true)
      writeFileSync(join(options.root, `${key}.release`), 'recorded original operation', {
        flag: 'wx',
      });
    return ref;
  };
  const collect = async (key: string, context: ActionContext) => {
    const existing = await context.records.get(resultKey(key));
    if (existing)
      return {
        outcome: 'succeeded' as const,
        content: 'Original capsule reused',
        artifactRefs: [object(existing.value).artifact as unknown as ArtifactRef],
      };
    const operation = await context.records.get(`capsule/${key}/operation`);
    if (!operation) throw Error('original_capsule_operation_missing');
    const ref = object(operation.value).ref as unknown as OperationRef;
    const result = await context.operations.wait(ref, { signal: context.signal, timeoutMs: 5000 });
    if (result.status !== 'succeeded')
      return {
        outcome: result.status === 'cancelled' ? ('cancelled' as const) : ('failed' as const),
        content: `Capsule ${result.status}`,
      };
    const bytes = readFileSync(join(options.root, `${key}.capsule`));
    const details = object(object(result.result).details!);
    if (details.digest !== digest(bytes) || details.bytes !== String(bytes.length))
      throw Error('actual_capsule_bytes_mismatch');
    const artifact = await context.artifacts!.publish({
      key: `capsule-${key}-result`,
      content: bytes,
      mediaType: 'application/x-fixture-capsule',
    });
    await context.records.write({
      key: resultKey(key),
      expectedRevision: null,
      contentType: type('result'),
      contentVersion: 1,
      executable: true,
      value: {
        key,
        artifact: artifact as unknown as Json,
        outputDigest: digest(bytes),
        bytes: String(bytes.length),
        executionId: result.id,
        resultRevision: result.resultRevision,
        sourceDigest: object(operation.value).sourceDigest!,
        ref: ref as unknown as Json,
      },
    });
    return {
      outcome: 'succeeded' as const,
      content: 'Complete capsule sealed',
      artifactRefs: [artifact],
    };
  };
  const extension: Extension = defineExtension({
    id: capsuleId,
    version: '1.0.0',
    apiMajor: 1,
    records: ['request', 'operation', 'result', 'acceptance'].map((part) => ({
      contentType: type(part),
      contentVersion: 1,
      schema: { type: 'object' } as JsonSchema,
    })),
    tools: [
      {
        id: `${capsuleId}.require`,
        version: '1',
        description: 'Create a real capsule and mandatory completion proof',
        inputSchema,
        async execute(input, context) {
          await launch(input, context, true);
          return collect(String(object(input).key), context);
        },
      },
    ],
    jobs: [
      {
        id: `${capsuleId}.pack`,
        version: '1',
        description: 'Owned Node process packs exact bytes',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' }, sourceDigest: { type: 'string' } },
          required: ['key', 'sourceDigest'],
          additionalProperties: false,
        },
        recovery: {
          version: '1',
          configuration: {
            mechanism: 'owned-node-capsule',
            format: 'capsule@1',
            rootIdentity: digest(options.root),
            workerIdentity: digest(options.workerPath),
          },
        },
        async start(input, context) {
          context.signal.throwIfAborted();
          const key = String(object(input).key);
          const request = JSON.parse(
            readFileSync(join(options.root, `${key}.request`), 'utf8'),
          ) as { payload: string };
          if (digest(request.payload) !== object(input).sourceDigest)
            throw Error('source_digest_mismatch');
          if (live.has(key) || existsSync(join(options.root, `${key}.capsule`)))
            throw Error('capsule_launch_already_observed');
          const child = spawn(options.nodePath, [options.workerPath, options.root, key], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {},
          });
          const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve, reject) => {
              child.once('error', reject);
              child.once('exit', (code, signal) => resolve({ code, signal }));
            },
          );
          live.set(key, { child, ended });
          starts++;
          return { reference: { key, pid: child.pid!, sourceDigest: object(input).sourceDigest! } };
        },
        async *observe(handle: JobHandle) {
          const key = String(object(handle.reference).key),
            entry = live.get(key);
          if (!entry) throw Error('cold_job_observation_unavailable');
          const ended = await entry.ended;
          if (ended.code !== 0) {
            yield {
              type: 'terminal',
              supervision: 'ended',
              result: { outcome: 'cancelled', content: 'Owned process ended before publication' },
            };
            return;
          }
          const bytes = readFileSync(join(options.root, `${key}.capsule`));
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: {
              outcome: 'succeeded',
              content: 'Owned capsule complete',
              details: { digest: digest(bytes), bytes: String(bytes.length) },
            },
          };
        },
        async cancel(handle) {
          const entry = live.get(String(object(handle.reference).key));
          if (!entry) return { status: 'unknown' };
          if (entry.child.exitCode !== null || entry.child.signalCode !== null)
            return { status: 'already_finished' };
          cancels++;
          entry.child.kill('SIGTERM');
          await entry.ended;
          return { status: 'stopped' };
        },
        async dispose(handle) {
          const entry = live.get(String(object(handle.reference).key));
          if (entry && entry.child.exitCode === null && entry.child.signalCode === null)
            throw Error('owned_process_cleanup_unconfirmed');
        },
        async reconcile(reference) {
          try {
            process.kill(Number(object(reference).pid), 0);
            return { status: 'unavailable', reason: 'original_process_end_not_confirmed' };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              return { status: 'unavailable', reason: 'original_process_end_not_confirmed' };
          }
          const key = String(object(reference).key),
            path = join(options.root, `${key}.capsule`);
          if (!existsSync(path))
            return { status: 'unavailable', reason: 'no_complete_original_bytes' };
          const bytes = readFileSync(path);
          return {
            status: 'observed',
            supervision: 'ended',
            result: {
              outcome: 'succeeded',
              content: 'Original bytes observed',
              details: { digest: digest(bytes), bytes: String(bytes.length) },
            },
            evidence: { key, digest: digest(bytes) },
          };
        },
      },
    ],
    actions: [
      {
        id: 'stage',
        version: '1',
        description: 'Stage one explicitly detached capsule',
        inputSchema,
        async prepare(input, context) {
          const existing = await context.records.get(requestKey(String(object(input).key)));
          if (
            existing &&
            object(existing.value).sourceDigest !== digest(String(object(input).payload))
          )
            throw Error('capsule_identity_conflict');
          return input;
        },
        async execute(input, context) {
          const ref = await launch(input, context);
          return {
            outcome: 'succeeded',
            content: 'Detached capsule staged',
            details: { ref: ref as unknown as Json },
          };
        },
      },
      {
        id: 'collect',
        version: '1',
        description: 'Collect original detached bytes without launch',
        inputSchema: keySchema,
        async prepare(input, context) {
          if (!(await context.records.get(`capsule/${object(input).key}/operation`)))
            throw Error('original_capsule_operation_missing');
          return input;
        },
        async execute(input, context) {
          return collect(String(object(input).key), context);
        },
      },
      {
        id: 'accept',
        version: '1',
        description: 'CAS acknowledgement of one exact sealed capsule',
        inputSchema: keySchema,
        async prepare(input, context) {
          const key = String(object(input).key),
            result = await context.records.get(resultKey(key)),
            previous = await context.records.get(`capsule/${key}/acceptance`);
          if (!result) throw Error('sealed_capsule_missing');
          return {
            key,
            resultRevision: result.revision,
            outputDigest: object(result.value).outputDigest!,
            expectedRevision: previous?.revision ?? null,
          };
        },
        async execute(input, context) {
          const values = object(input);
          await context.records.write({
            key: `capsule/${values.key}/acceptance`,
            expectedRevision: values.expectedRevision as string | null,
            contentType: type('acceptance'),
            contentVersion: 1,
            value: {
              resultRevision: values.resultRevision!,
              outputDigest: values.outputDigest!,
              accepted: true,
            },
          });
          return { outcome: 'succeeded', content: 'Exact capsule acknowledged' };
        },
      },
      {
        id: 'cancel',
        version: '1',
        description: 'Cancel only the original stored capsule operation',
        inputSchema: keySchema,
        async prepare(input, context) {
          const operation = await context.records.get(`capsule/${object(input).key}/operation`);
          if (!operation) throw Error('original_capsule_operation_missing');
          return { key: object(input).key!, ref: object(operation.value).ref! };
        },
        async execute(input, context) {
          await context.operations.cancel!(object(input).ref as unknown as OperationRef, {
            commandId: `cancel-capsule-${object(input).key}`,
          });
          return { outcome: 'succeeded', content: 'Original cancellation requested' };
        },
      },
    ],
    queries: [
      {
        id: 'capsules',
        version: '1',
        description: 'Read original capsule records and job facts without starting work',
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'array', items: { type: 'object' } },
        async execute(_input, context): Promise<PublicView[]> {
          const operations = await context.records.list({
            contentType: type('operation'),
            limit: 100,
          });
          return Promise.all(
            operations.map(async (record) => {
              const value = object(record.value),
                ref = value.ref as unknown as OperationRef,
                result = await context.records.get(resultKey(String(value.key))),
                execution = await context.getExecution(ref.executionId!);
              return {
                extensionId: capsuleId,
                contentType: type('catalogue'),
                contentVersion: 1,
                summary: `Capsule ${value.key}: ${execution?.status ?? 'unknown'}`,
                payload: {
                  operation: record.value,
                  result: result?.value ?? null,
                  execution: execution as unknown as Json,
                },
                artifactRefs: result
                  ? [object(result.value).artifact as unknown as ArtifactRef]
                  : [],
                actions: result
                  ? [
                      {
                        actionId: 'accept',
                        definitionVersion: '1',
                        label: 'Accept capsule',
                        input: { key: value.key! },
                      },
                    ]
                  : [],
              };
            }),
          );
        },
      },
    ],
    ...(options.missingCondition
      ? {}
      : {
          conditions: {
            async evaluate(requirements, phase, context) {
              return Promise.all(
                requirements.map(async (requirement) => {
                  const scoped = await context!.forRequirement(requirement);
                  const request = await scoped.records.get(requirement.recordKey);
                  const key = request && String(object(request.value).key);
                  const operation = key
                    ? await scoped.records.get(`capsule/${key}/operation`)
                    : null;
                  const ref = operation
                    ? (object(operation.value).ref as unknown as OperationRef)
                    : null;
                  const execution = ref?.executionId
                    ? await scoped.getExecution(ref.executionId)
                    : null;
                  const parent = execution?.parentExecutionId
                    ? await scoped.getExecution(execution.parentExecutionId)
                    : null;
                  const exactProducer =
                    !!request &&
                    !!execution &&
                    !!parent &&
                    execution.kind === 'job' &&
                    execution.sessionId === scoped.sessionId &&
                    execution.definitionId === `${capsuleId}.pack` &&
                    execution.definitionVersion === '1' &&
                    execution.originStoreId === requirement.originStoreId &&
                    execution.inputDigest ===
                      digest(JSON.stringify(object(request.value).jobInput)) &&
                    parent.kind === 'tool' &&
                    parent.runId === requirement.runId &&
                    parent.definitionId === `${capsuleId}.require` &&
                    parent.originStoreId === requirement.originStoreId;
                  // The producer must finish before its parent can publish the sealed capsule.
                  // This clause is bound to that exact original Job boundary; it cannot satisfy
                  // the parent Tool or Run's separate complete-byte obligation.
                  const producerCompletion =
                    exactProducer &&
                    phase === 'completion' &&
                    context!.boundary.kind === 'job' &&
                    context!.boundary.executionId === execution!.id &&
                    ['dispatching', 'running'].includes(execution!.status);
                  const result = key ? await scoped.records.get(resultKey(key)) : null;
                  const passed =
                    producerCompletion ||
                    (exactProducer &&
                      !!result &&
                      execution!.status === 'succeeded' &&
                      execution!.resultRevision === object(result.value).resultRevision &&
                      object(result.value).executionId === execution!.id &&
                      object(result.value).sourceDigest === object(request!.value).sourceDigest);
                  return {
                    requirement,
                    recordRevision: request?.revision ?? requirement.revision,
                    outcome: passed ? ('satisfied' as const) : ('unsatisfied' as const),
                    evidence: {
                      phase,
                      key: key ?? null,
                      executionId: execution?.id ?? null,
                      producerBoundary: producerCompletion,
                    },
                  };
                }),
              );
            },
          },
        }),
  });
  return {
    extension,
    stats: () => ({ starts, cancels }),
    release: (key: string) =>
      writeFileSync(join(options.root, `${key}.release`), 'release', { flag: 'wx' }),
    async drain() {
      for (const entry of live.values())
        if (entry.child.exitCode === null && entry.child.signalCode === null) {
          entry.child.kill('SIGTERM');
          await entry.ended;
        }
    },
  };
}
