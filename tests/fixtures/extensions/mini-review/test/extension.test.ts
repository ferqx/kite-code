import { expect, test } from 'bun:test';
import type {
  ActionContext,
  ExtensionRecord,
  OperationRef,
  PublicExecution,
} from '@kite-ai/agent/extensions';
import { createMiniReview } from '../src';

function fixture() {
  const sample = createMiniReview();
  let ensureCalls = 0;
  const records = new Map<string, ExtensionRecord>();
  const operations = new Map<string, OperationRef>();
  const executions = new Map<string, PublicExecution>();
  const context: ActionContext = {
    sessionId: 's',
    executionId: 'parent',
    signal: new AbortController().signal,
    async getRun(id) {
      return id === 'source-run'
        ? {
            id,
            sessionId: 's',
            status: 'completed',
            isActive: false,
            waitingForResults: [],
            createdAt: 1,
            finishedAt: 2,
          }
        : null;
    },
    async getExecution(id) {
      return id === 'source-execution'
        ? {
            id,
            sessionId: 's',
            runId: 'source-run',
            kind: 'model',
            status: 'succeeded',
            result: 'source result',
            resultRevision: '1',
          }
        : null;
    },
    records: {
      async get(key) {
        return records.get(key) ?? null;
      },
      async list(options) {
        return [...records.values()].filter(
          (value) => !options?.contentType || value.contentType === options.contentType,
        );
      },
      async write(value) {
        const previous = records.get(value.key);
        if ((previous?.revision ?? null) !== value.expectedRevision)
          throw new Error('revision_conflict');
        const record: ExtensionRecord = {
          extensionId: sample.extension.id,
          sessionId: 's',
          key: value.key,
          revision: String(Number(previous?.revision ?? 0) + 1),
          contentType: value.contentType,
          contentVersion: value.contentVersion,
          originStoreId: value.executable ? 'store' : null,
          value: value.value,
        };
        records.set(value.key, record);
        return record;
      },
    },
    operations: {
      async ensure(value) {
        ensureCalls++;
        const existing = operations.get(value.key);
        if (existing) return existing;
        expect(value.planRecordKey).toBeDefined();
        expect(records.get(value.planRecordKey!)?.originStoreId).toBe('store');
        const id = `operation-${value.key}`;
        const result = await sample.extension.tools[0]!.execute(value.request.input, {
          ...context,
          sessionId: 's',
          runId: null,
          executionId: id,
          signal: context.signal,
          reportProgress() {},
          async requestInput() {
            throw new Error('fixture_does_not_request_input');
          },
          async requestInteraction() {
            throw new Error('fixture_does_not_request_interaction');
          },
        });
        const ref = {
          commandId: id,
          sessionId: 's',
          originStoreId: 'store',
          extensionId: sample.extension.id,
          key: value.key,
          executionId: id,
        };
        executions.set(id, {
          id,
          sessionId: 's',
          runId: null,
          kind: 'tool',
          status: 'succeeded',
          result: result as never,
          resultRevision: '1',
        });
        operations.set(value.key, ref);
        return ref;
      },
      async get(ref) {
        return executions.get(ref.executionId!) ?? null;
      },
      async wait(ref) {
        return executions.get(ref.executionId!)!;
      },
      async waitAny() {
        throw new Error('fixture_does_not_wait_for_multiple_operations');
      },
      async readAgent() {
        throw new Error('fixture_does_not_read_child_agents');
      },
      async sendAgentInput() {
        throw new Error('fixture_does_not_send_child_input');
      },
      async readOutput() {
        throw new Error('fixture_does_not_read_job_output');
      },
    },
  };
  return {
    sample,
    context,
    records,
    get ensureCalls() {
      return ensureCalls;
    },
  };
}

test('analyze saves executable plan before exactly one controlled operation; explicit new identity reruns', async () => {
  const f = fixture();
  const analyze = f.sample.extension.actions[0]!;
  const input = {
    businessKey: 'first',
    sourceRunId: 'source-run',
    sourceExecutionId: 'source-execution',
  };
  const prepared = await analyze.prepare(input, f.context);
  expect((await analyze.execute(prepared, f.context)).outcome).toBe('succeeded');
  expect((await analyze.execute(prepared, f.context)).outcome).toBe('succeeded');
  expect(f.sample.analyses).toBe(1);
  expect(f.ensureCalls).toBe(1);
  await expect(
    analyze.execute(
      {
        businessKey: 'first',
        source: {
          runId: 'different',
          executionId: 'source-execution',
          resultRevision: '1',
          result: 'source result',
        },
      },
      f.context,
    ),
  ).rejects.toThrow('business_identity_conflict');
  expect(f.ensureCalls).toBe(1);
  const next = await analyze.prepare({ ...input, businessKey: 'second' }, f.context);
  await analyze.execute(next, f.context);
  expect(f.sample.analyses).toBe(2);
  expect(f.records.size).toBe(4);
  await expect(analyze.prepare({ ...input, sourceRunId: 'foreign' }, f.context)).rejects.toThrow(
    'source_result_unavailable',
  );
});

test('query and CAS mark are model-free, preserve source/future fields and expose generic actions', async () => {
  const f = fixture();
  expect(f.sample.extension.records[1]?.schema).toMatchObject({
    additionalProperties: true,
    required: ['businessKey', 'source', 'findings', 'marked'],
  });
  const [analyze, mark] = f.sample.extension.actions;
  await analyze!.execute(
    await analyze!.prepare(
      { businessKey: 'first', sourceRunId: 'source-run', sourceExecutionId: 'source-execution' },
      f.context,
    ),
    f.context,
  );
  const record = f.records.get('review/first/findings')!;
  record.value = { ...(record.value as Record<string, never>), future: { preserved: true } };
  const [view] = await f.sample.extension.queries[0]!.execute({}, f.context);
  expect(view?.summary).toContain('unmarked');
  expect(view?.actions[1]?.input).toMatchObject({ businessKey: '', sourceRunId: 'source-run' });
  const prepared = await mark!.prepare(view!.actions[0]!.input, f.context);
  await mark!.execute(prepared, f.context);
  expect(f.records.get(record.key)?.value).toMatchObject({
    marked: true,
    future: { preserved: true },
    source: { executionId: 'source-execution' },
  });
  await expect(mark!.execute(prepared, f.context)).rejects.toThrow('revision_conflict');
  expect(f.sample.analyses).toBe(1);
});
