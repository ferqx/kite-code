import {
  type ActionDefinition,
  defineExtension,
  type Json,
  type JsonSchema,
  type PublicView,
  type QueryDefinition,
  type ToolDefinition,
} from '@kite-ai/agent/extensions';

const extensionId = 'fixture.mini-review';
const planType = 'fixture.mini-review.plan';
const findingType = 'fixture.mini-review.findings';
const objectSchema = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const text: JsonSchema = { type: 'string', minLength: 1 };
const sourceSchema = objectSchema({
  runId: text,
  executionId: text,
  resultRevision: text,
  result: {},
});
const planSchema = objectSchema({ businessKey: text, source: sourceSchema });
const findingsSchema: JsonSchema = {
  ...objectSchema({
    businessKey: text,
    source: sourceSchema,
    findings: { type: 'array', items: { type: 'string' } },
    marked: { type: 'boolean' },
  }),
  additionalProperties: true,
};
function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_fixture_input');
  return value;
}
function string(value: Json | undefined): string {
  if (typeof value !== 'string' || !value) throw new Error('invalid_fixture_input');
  return value;
}
const key = (businessKey: string) => `review/${businessKey}`;

export function createMiniReview() {
  let analyses = 0;
  const analyzeTool: ToolDefinition = {
    id: `${extensionId}.fixed-analysis`,
    version: '1',
    description: 'Counted deterministic local analysis',
    inputSchema: planSchema,
    async execute(input, context) {
      context.signal.throwIfAborted();
      analyses++;
      const plan = object(input);
      return {
        outcome: 'succeeded',
        content: 'Fixed analysis completed',
        details: { findings: ['Check the saved source result.'], source: plan.source! },
      };
    },
  };
  const analyze: ActionDefinition = {
    id: `${extensionId}.analyze`,
    version: '1',
    description: 'Analyze one authorized source result using a new explicit business identity',
    inputSchema: objectSchema({
      businessKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' },
      sourceRunId: text,
      sourceExecutionId: text,
    }),
    async prepare(input, context) {
      const values = object(input);
      const businessKey = string(values.businessKey);
      const run = await context.getRun(string(values.sourceRunId));
      const execution = await context.getExecution(string(values.sourceExecutionId));
      if (
        !run ||
        !execution ||
        execution.runId !== run.id ||
        execution.sessionId !== context.sessionId ||
        run.sessionId !== context.sessionId ||
        execution.status !== 'succeeded'
      )
        throw new Error('source_result_unavailable');
      return {
        businessKey,
        source: {
          runId: run.id,
          executionId: execution.id,
          resultRevision: execution.resultRevision,
          result: execution.result,
        },
      };
    },
    async execute(prepared, context) {
      const plan = object(prepared);
      const businessKey = string(plan.businessKey);
      const findingKey = `${key(businessKey)}/findings`;
      const saved = await context.records.get(findingKey);
      if (saved) {
        const value = object(saved.value);
        if (
          value.businessKey !== businessKey ||
          JSON.stringify(value.source) !== JSON.stringify(plan.source)
        )
          throw new Error('business_identity_conflict');
        return {
          outcome: 'succeeded',
          content: 'Saved review findings reused',
          details: { recordKey: findingKey, operationKey: businessKey },
        };
      }
      const planKey = `${key(businessKey)}/plan`;
      const previous = await context.records.get(planKey);
      if (previous && JSON.stringify(previous.value) !== JSON.stringify(prepared))
        throw new Error('business_identity_conflict');
      if (!previous)
        await context.records.write({
          key: planKey,
          expectedRevision: null,
          contentType: planType,
          contentVersion: 1,
          value: prepared,
          executable: true,
        });
      const ref = await context.operations.ensure({
        key: businessKey,
        planRecordKey: planKey,
        request: {
          kind: 'tool',
          definitionId: analyzeTool.id,
          definitionVersion: analyzeTool.version,
          input: prepared,
        },
      });
      const result = await context.operations.wait(ref, {
        signal: context.signal,
        timeoutMs: 5000,
      });
      if (result.status !== 'succeeded')
        return {
          outcome:
            result.status === 'cancelled'
              ? 'cancelled'
              : result.status === 'outcome_unknown'
                ? 'outcome_unknown'
                : 'failed',
          content: `Analysis ${result.status}`,
        };
      const existing = await context.records.get(findingKey);
      if (!existing)
        await context.records.write({
          key: findingKey,
          expectedRevision: null,
          contentType: findingType,
          contentVersion: 1,
          value: {
            businessKey,
            source: plan.source!,
            findings: ['Check the saved source result.'],
            marked: false,
          },
        });
      return {
        outcome: 'succeeded',
        content: 'Review findings saved',
        details: { recordKey: findingKey, operationKey: businessKey },
      };
    },
  };
  const mark: ActionDefinition = {
    id: `${extensionId}.mark`,
    version: '1',
    description: 'Mark an existing result with optimistic concurrency',
    inputSchema: objectSchema({
      recordKey: text,
      expectedRevision: text,
      marked: { type: 'boolean' },
    }),
    async prepare(input, context) {
      const values = object(input);
      const record = await context.records.get(string(values.recordKey));
      if (
        !record ||
        record.contentType !== findingType ||
        record.revision !== string(values.expectedRevision)
      )
        throw new Error('review_revision_conflict');
      return {
        recordKey: record.key,
        expectedRevision: record.revision,
        value: { ...object(record.value), marked: values.marked! },
      };
    },
    async execute(prepared, context) {
      const value = object(prepared);
      await context.records.write({
        key: string(value.recordKey),
        expectedRevision: string(value.expectedRevision),
        contentType: findingType,
        contentVersion: 1,
        value: value.value!,
      });
      return { outcome: 'succeeded', content: 'Review mark saved' };
    },
  };
  const query: QueryDefinition = {
    id: `${extensionId}.results`,
    version: '1',
    description: 'Read saved results with a generic public presentation',
    inputSchema: objectSchema({}),
    outputSchema: {
      type: 'array',
      items: objectSchema({
        extensionId: text,
        contentType: text,
        contentVersion: { type: 'integer', minimum: 1 },
        summary: { type: 'string' },
        payload: {},
        artifactRefs: {
          type: 'array',
          items: objectSchema({ id: text, mediaType: text, size: text }),
        },
        actions: {
          type: 'array',
          items: objectSchema({ actionId: text, definitionVersion: text, label: text, input: {} }),
        },
      }),
    },
    async execute(_input, context): Promise<PublicView[]> {
      const records = await context.records.list({ contentType: findingType, limit: 100 });
      return records.map((record): PublicView => {
        const value = object(record.value);
        return {
          extensionId,
          contentType: findingType,
          contentVersion: record.contentVersion,
          summary: `Review ${string(value.businessKey)}: ${value.marked ? 'marked' : 'unmarked'}`,
          payload: record.value,
          artifactRefs: [],
          actions: [
            {
              actionId: mark.id,
              definitionVersion: mark.version,
              label: value.marked ? 'Unmark' : 'Mark',
              input: {
                recordKey: record.key,
                expectedRevision: record.revision,
                marked: !value.marked,
              },
            },
            {
              actionId: analyze.id,
              definitionVersion: analyze.version,
              label: 'Run a new analysis',
              input: {
                businessKey: '',
                sourceRunId: object(value.source!).runId!,
                sourceExecutionId: object(value.source!).executionId!,
              },
            },
          ],
        };
      });
    },
  };
  const extension = defineExtension({
    id: extensionId,
    version: '1',
    apiMajor: 1,
    tools: [analyzeTool],
    actions: [analyze, mark],
    queries: [query],
    records: [
      { contentType: planType, contentVersion: 1, schema: planSchema },
      { contentType: findingType, contentVersion: 1, schema: findingsSchema },
    ],
  });
  return {
    extension,
    get analyses() {
      return analyses;
    },
  };
}
