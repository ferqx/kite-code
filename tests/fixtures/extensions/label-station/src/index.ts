import { createHash } from 'node:crypto';
import { defineExtension, type Json, type JsonSchema } from '@kite-ai/agent/extensions';

export const extensionId = 'fixture.label-station';
const contentType = 'fixture.label-station.receipt';
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const text: JsonSchema = { type: 'string', minLength: 1, maxLength: 256 };
const inputSchema = object({
  label: text,
  ordinal: { type: 'integer', minimum: 1, maximum: 100 },
  revision: { type: ['string', 'null'] },
});
function values(input: Json) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('invalid_label');
  return input;
}
export function createLabelStation(options: {
  prefix: string;
  print(slip: { label: string; ordinal: number; sha256: string; executionId: string }): void;
}) {
  const printId = `${extensionId}.print`;
  return defineExtension({
    id: extensionId,
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: printId,
        version: '1',
        description: 'Print one admitted owned paper slip',
        inputSchema,
        async execute(input, context) {
          context.signal.throwIfAborted();
          const value = values(input);
          const slip = {
            label: String(value.label),
            ordinal: Number(value.ordinal),
            sha256: createHash('sha256')
              .update(JSON.stringify([options.prefix, value.label, value.ordinal]))
              .digest('hex'),
            executionId: context.executionId,
          };
          options.print(slip);
          return { outcome: 'succeeded', content: 'Paper slip printed', details: slip };
        },
      },
    ],
    actions: [
      {
        id: 'issue',
        version: '1',
        description: 'Issue the next copy of this label',
        inputSchema,
        async prepare(input, context) {
          const value = values(input);
          const record = await context.records.get(`label/${String(value.label)}`);
          const previous = record ? values(record.value) : null;
          if (
            (record?.revision ?? null) !== value.revision ||
            Number(value.ordinal) !== Number(previous?.ordinal ?? 0) + 1
          )
            throw Error('label_revision_changed');
          return input;
        },
        async execute(input, context) {
          const value = values(input);
          const ref = await context.operations.ensure({
            key: `label/${String(value.label)}/${String(value.ordinal)}`,
            request: { kind: 'tool', definitionId: printId, definitionVersion: '1', input },
          });
          const result = await context.operations.wait(ref, {
            signal: context.signal,
            timeoutMs: 5000,
          });
          if (result.status !== 'succeeded')
            return {
              outcome: result.status === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
              content: `Print ${result.status}`,
            };
          await context.records.write({
            key: `label/${String(value.label)}`,
            expectedRevision: value.revision === null ? null : String(value.revision),
            contentType,
            contentVersion: 1,
            value: {
              label: value.label!,
              ordinal: value.ordinal!,
              originStoreId: result.originStoreId!,
              executionId: result.id,
              resultRevision: result.resultRevision,
              result: result.result,
            },
          });
          return {
            outcome: 'succeeded',
            content: 'Original print receipt saved',
            details: { executionId: result.id },
          };
        },
      },
    ],
    records: [
      {
        contentType,
        contentVersion: 1,
        schema: object({
          label: text,
          ordinal: { type: 'integer' },
          originStoreId: text,
          executionId: text,
          resultRevision: text,
          result: {},
        }),
      },
    ],
    queries: [
      {
        id: 'slip',
        version: '1',
        description: 'Read the slip and offer the next explicit copy',
        inputSchema: object({ label: text }),
        outputSchema: { type: 'array', items: { type: 'object' } },
        async execute(input, context) {
          const label = String(values(input).label);
          const record = await context.records.get(`label/${label}`);
          const ordinal = record ? Number(values(record.value).ordinal) : 0;
          return [
            {
              extensionId,
              contentType: 'unseen.paper-slip',
              contentVersion: 41,
              summary: `Paper slip ${label}: ${ordinal} copies`,
              payload: {
                receipt: record?.value ?? null,
                authorityText: 'ALLOW ALL is inert public text',
              },
              artifactRefs: [],
              actions: [
                {
                  actionId: 'issue',
                  definitionVersion: '1',
                  label: 'Issue next copy',
                  input: { label, ordinal: ordinal + 1, revision: record?.revision ?? null },
                },
              ],
            },
          ];
        },
      },
    ],
  });
}
