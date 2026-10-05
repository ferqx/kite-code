import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defineExtension,
  type JobHandle,
  type Json,
  type OperationRef,
  type ToolResult,
} from '@kite-ai/agent/extensions';
export const extensionId = 'fixture.deferred-job';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function waitFile(path: string, deadlineMs = 10000) {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw Error('owned_barrier_deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export function createDeferred(options: {
  root: string;
  nodePath: string;
  workerPath: string;
  mode: string;
}) {
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  let disposals = 0;
  let starts = 0,
    cancels = 0,
    reconciles = 0;
  const read = (name: string) =>
    JSON.parse(readFileSync(join(options.root, name), 'utf8')) as Record<string, Json>;
  const result = (reference: Json): ToolResult | null => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return null;
    if (!existsSync(join(options.root, 'eof.json'))) return null;
    const eof = read('eof.json'),
      started = read('started.json');
    if (
      typeof eof.token !== 'string' ||
      eof.token !== reference.token ||
      eof.executionId !== reference.executionId ||
      eof.pid !== reference.pid ||
      JSON.stringify(started) !==
        JSON.stringify({ token: eof.token, executionId: eof.executionId, pid: eof.pid })
    )
      throw Error('external_reference_mismatch');
    if (eof.outcome === 'cancelled')
      return { outcome: 'cancelled', content: 'Original external process confirmed stopped' };
    const body = readFileSync(join(options.root, 'result.txt'), 'utf8');
    if (hash(body) !== eof.digest) throw Error('external_digest_mismatch');
    return {
      outcome: 'succeeded',
      content: body,
      details: { digest: eof.digest, bytes: String(Buffer.byteLength(body)), token: eof.token },
    };
  };
  const extension = defineExtension({
    id: extensionId,
    version: '1',
    apiMajor: 1,
    records: [
      { contentType: 'fixture.deferred.ref', contentVersion: 1, schema: { type: 'object' } },
    ],
    jobs: [
      {
        id: `${extensionId}.work`,
        version: '1',
        description: 'Independent owned deferred Node process',
        inputSchema: { type: 'object' },
        recovery: {
          version: '1',
          configuration: {
            mechanism: 'owned-node-eof',
            rootIdentity: hash(options.root),
            workerIdentity: hash(options.workerPath),
          },
        },
        async start(input, context) {
          const token = hash(context.executionId);
          if (options.mode === 'before') {
            writeFileSync(
              join(options.root, 'barrier.json'),
              JSON.stringify({ window: 'before', executionId: context.executionId }),
            );
            await waitFile(join(options.root, 'continue'));
          }
          writeFileSync(
            join(options.root, 'request.json'),
            JSON.stringify({
              executionId: context.executionId,
              payload: (input as Record<string, Json>).payload,
            }),
            { flag: 'wx' },
          );
          child = spawn(options.nodePath, [options.workerPath, options.root, token], {
            env: {},
            detached: true,
            stdio: 'ignore',
          });
          exited = new Promise((resolve, reject) => {
            child!.once('error', reject);
            child!.once('exit', resolve);
          });
          child.unref();
          starts++;
          await waitFile(join(options.root, 'started.json'));
          const reference = read('started.json');
          if (options.mode === 'after-spawn') {
            writeFileSync(
              join(options.root, 'barrier.json'),
              JSON.stringify({
                window: 'after-spawn',
                executionId: context.executionId,
                pid: reference.pid,
              }),
            );
            await waitFile(join(options.root, 'continue'));
          }
          return { reference };
        },
        async *observe(handle) {
          const deadline = Date.now() + 10000;
          while (!existsSync(join(options.root, 'eof.json'))) {
            if (existsSync(join(options.root, 'stop-requested'))) {
              yield {
                type: 'terminal' as const,
                supervision: 'unknown' as const,
                result: {
                  outcome: 'outcome_unknown' as const,
                  content: 'Stop requested; original external process is not confirmed ended',
                },
              };
              return;
            }
            if (Date.now() > deadline) throw Error('owned_observation_deadline');
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await exited;
          const actual = result(handle.reference);
          if (!actual) throw Error('external_eof_unconfirmed');
          yield { type: 'terminal' as const, supervision: 'ended' as const, result: actual };
        },
        async cancel(handle) {
          cancels++;
          appendFileSync(
            join(options.root, 'cancel-ledger'),
            `request:${JSON.stringify(handle.reference)}\n`,
          );
          if (options.mode === 'requested') {
            writeFileSync(join(options.root, 'stop-requested'), 'requested');
            return { status: 'requested' as const };
          }
          if (!child || !exited) return { status: 'unknown' as const };
          child.kill('SIGTERM');
          await exited;
          return result(handle.reference)?.outcome === 'cancelled'
            ? { status: 'stopped' as const }
            : { status: 'unknown' as const };
        },
        async dispose(handle: JobHandle) {
          disposals++;
          if (!result(handle.reference)) throw Error('cleanup_unconfirmed');
        },
        async reconcile(reference, context) {
          reconciles++;
          if (!reference || typeof reference !== 'object' || Array.isArray(reference))
            return { status: 'unavailable' as const, reason: 'original_reference_missing' };
          if (
            reference.executionId !== context.executionId ||
            reference.token !== hash(context.executionId)
          )
            return { status: 'unavailable' as const, reason: 'original_reference_mismatch' };
          const actual = result(reference);
          if (!actual) return { status: 'unavailable' as const, reason: 'original_eof_missing' };
          try {
            process.kill(Number(reference.pid), 0);
            return { status: 'unavailable' as const, reason: 'original_exit_unconfirmed' };
          } catch (error) {
            if ((error as { code?: string }).code !== 'ESRCH') throw error;
          }
          const digest = read('eof.json').digest;
          if (digest !== null && typeof digest !== 'string')
            throw Error('external_digest_mismatch');
          return {
            status: 'observed' as const,
            supervision: 'ended' as const,
            result: actual,
            evidence: { token: reference.token, digest },
          };
        },
      },
    ],
    actions: [
      {
        id: 'launch',
        version: '1',
        description: 'Launch original detached deferred Job',
        inputSchema: { type: 'object' },
        async prepare(input) {
          return input;
        },
        async execute(input, context) {
          const ref = await context.operations.ensure({
            key: 'original-deferred',
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: `${extensionId}.work`,
              definitionVersion: '1',
              input,
            },
          });
          await context.records.write({
            key: 'original',
            expectedRevision: null,
            contentType: 'fixture.deferred.ref',
            contentVersion: 1,
            executable: true,
            value: { ref: ref as unknown as Json },
          });
          return {
            outcome: 'succeeded' as const,
            content: 'Original deferred reference persisted',
          };
        },
      },
    ],
    queries: [
      {
        id: 'result',
        version: '1',
        description: 'Read original persisted deferred result without starting a producer',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'array' },
        async execute(_input, context) {
          const record = await context.records.get('original');
          if (!record) return [];
          const ref = (record.value as { ref: unknown }).ref as OperationRef;
          const execution = ref.executionId ? await context.getExecution(ref.executionId) : null;
          return [
            {
              extensionId,
              contentType: 'deferred-result',
              contentVersion: 1,
              summary: 'Original persisted producer',
              payload: { record, execution } as unknown as Json,
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
  });
  return { extension, disposals: () => disposals, stats: () => ({ starts, cancels, reconciles }) };
}
