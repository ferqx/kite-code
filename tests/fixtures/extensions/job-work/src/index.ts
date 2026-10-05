import { appendFileSync } from 'node:fs';
import {
  type ActionContext,
  defineExtension,
  type JobEvent,
  type JobHandle,
  type Json,
  type JsonSchema,
  type OperationRef,
} from '@kite-ai/agent/extensions';

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const id = 'fixture.job-work';
const inputSchema: JsonSchema = {
  type: 'object',
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          cancellation: { enum: ['attached', 'detached'] },
          output: { type: 'boolean' },
          bulk: { type: 'boolean' },
        },
        required: ['key', 'cancellation'],
        additionalProperties: false,
      },
    },
    hold: { type: 'boolean' },
    cancelKey: { type: 'string' },
  },
  required: ['jobs'],
  additionalProperties: false,
};
interface Spec {
  key: string;
  cancellation: 'attached' | 'detached';
  output?: boolean;
  bulk?: boolean;
}
interface Input {
  jobs: Spec[];
  hold?: boolean;
  cancelKey?: string;
}
export function createJobWork(ledger: string, serial = false) {
  const states = new Map<
    string,
    {
      start: ReturnType<typeof barrier<void>>;
      end: ReturnType<typeof barrier<'succeeded' | 'cancelled'>>;
      disposed: ReturnType<typeof barrier<void>>;
      starts: number;
      cancels: number;
      spec?: Spec;
    }
  >();
  const admitted = new Map<string, ReturnType<typeof barrier<void>>>();
  const admission = (key: string) => {
    let value = admitted.get(key);
    if (!value) {
      value = barrier<void>();
      admitted.set(key, value);
    }
    return value;
  };
  const cancellation = new Map<string, ReturnType<typeof barrier<void>>>();
  const cancellationGate = (key: string) => {
    let value = cancellation.get(key);
    if (!value) {
      value = barrier<void>();
      cancellation.set(key, value);
    }
    return value;
  };
  const refs = new Map<string, OperationRef>();
  const state = (key: string) => {
    let value = states.get(key);
    if (!value) {
      value = {
        start: barrier<void>(),
        end: barrier(),
        disposed: barrier<void>(),
        starts: 0,
        cancels: 0,
      };
      states.set(key, value);
    }
    return value;
  };
  const launch = async (value: Json, context: ActionContext) => {
    const input = value as unknown as Input;
    for (const spec of input.jobs) {
      const ref = await context.operations.ensure({
        key: spec.key,
        cancellation: spec.cancellation,
        request: {
          kind: 'job',
          definitionId: `${id}.work`,
          definitionVersion: '1',
          input: spec as unknown as Json,
        },
      });
      refs.set(spec.key, ref);
    }
    for (const spec of input.jobs) admission(spec.key).resolve();
    if (input.cancelKey) {
      await cancellationGate(input.cancelKey).promise;
      if (!context.operations.cancel) throw new Error('operation_cancel_unavailable');
      await context.operations.cancel(refs.get(input.cancelKey)!, {
        commandId: 'fixture-ref-cancel',
      });
      await context.operations.wait(refs.get(input.cancelKey)!);
    }
    if (input.hold)
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    return {
      outcome: context.signal.aborted ? ('cancelled' as const) : ('succeeded' as const),
      content: 'Job references admitted',
    };
  };
  return {
    extension: defineExtension({
      id,
      version: '1',
      apiMajor: 1,
      jobs: [
        {
          id: `${id}.work`,
          version: '1',
          description: 'Harmless externally counted barrier Job',
          inputSchema: {},
          resources: {
            slot: 'process',
            ...(serial ? { serial: { scope: 'workspace' as const, key: 'shared' } } : {}),
          },
          async start(input: Json) {
            const spec = input as unknown as Spec;
            const s = state(spec.key);
            s.spec = spec;
            s.starts++;
            appendFileSync(ledger, `start:${spec.key}\n`);
            s.start.resolve();
            return { reference: { key: spec.key } };
          },
          async *observe(handle: JobHandle): AsyncIterable<JobEvent> {
            const key = (handle.reference as { key: string }).key;
            const s = state(key);
            if (s.spec?.output) {
              yield { type: 'output', stream: 'stdout', content: 'first' };
              yield { type: 'output', stream: 'stderr', content: 'second' };
              yield { type: 'progress', value: { phase: 'waiting' } };
              yield { type: 'output_dropped', stream: 'stdout', bytes: '9' };
              yield { type: 'output', stream: 'stderr', content: 'discarded' };
            }
            if (s.spec?.bulk)
              for (let index = 0; index < 40; index++)
                yield { type: 'output', stream: 'stdout', content: 'x'.repeat(32768) };
            const outcome = await s.end.promise;
            appendFileSync(ledger, `end:${key}:${outcome}\n`);
            yield { type: 'terminal', supervision: 'ended', result: { outcome, content: outcome } };
          },
          async cancel(handle: JobHandle) {
            const s = state((handle.reference as { key: string }).key);
            s.cancels++;
            s.end.resolve('cancelled');
            return { status: 'stopped' as const };
          },
          async dispose(handle: JobHandle) {
            state((handle.reference as { key: string }).key).disposed.resolve();
          },
        },
      ],
      tools: [
        {
          id: `${id}.launch`,
          version: '1',
          description: 'Normal Tool launches a controlled Job',
          inputSchema,
          execute: launch,
        },
      ],
      actions: [
        {
          id: `${id}.launch`,
          version: '1',
          description: 'Direct Action launches a controlled Job',
          inputSchema,
          async prepare(input: Json) {
            return input;
          },
          execute: launch,
        },
      ],
    }),
    cancel: (key: string) => cancellationGate(key).resolve(),
    admitted: (key: string) => admission(key).promise,
    started: (key: string) => state(key).start.promise,
    disposed: (key: string) => state(key).disposed.promise,
    finish: (key: string) => state(key).end.resolve('succeeded'),
    ref: (key: string) => refs.get(key)!,
    stats: (key: string) => ({ starts: state(key).starts, cancels: state(key).cancels }),
  };
}
