import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Extension, Json, ReadContext } from '../extensions';
import { canonicalJson } from '../json';
import { AgentError } from '../storage/types';
import { isSessionOutputName, isSessionOutputPath } from './session-output-path';

const contentType = 'builtin.files.output';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface SessionOutput {
  path: string;
  name: string;
  state: 'pending' | 'saved' | 'inherited';
  executionId: string;
  snapshot: Json;
}
const keyOf = (path: string) => `output/${digest(path)}`;
function decode(value: Json): SessionOutput {
  const output = value as unknown as SessionOutput;
  if (
    !output ||
    !isSessionOutputPath(output.path) ||
    !isSessionOutputName(output.name) ||
    output.path.split('/').at(-1) !== output.name ||
    !['pending', 'saved', 'inherited'].includes(output.state)
  )
    throw new AgentError('output_file_invalid');
  return output;
}
/** Retained read-only registration for historical Files deliveries; no model context,
 * tool override or special write capability is installed. */
export function withSessionOutputHistory(options: {
  profilePath: string;
  extension: Extension;
}): Extension {
  const profile = resolve(options.profilePath);
  async function records(context: ReadContext, path?: string) {
    const result = [];
    let afterKey: string | undefined;
    for (;;) {
      const page = await context.records.list({
        contentType,
        limit: 200,
        ...(afterKey ? { afterKey } : {}),
      });
      for (const record of page) {
        if (!record.key.startsWith('output/') && !record.key.startsWith('output-inherited/'))
          continue;
        const value = decode(record.value);
        if (value.path.split('/')[2] !== digest(context.sessionId))
          throw new AgentError('output_file_scope_denied');
        if (path && join(profile, ...value.path.split('/')) !== path) continue;
        result.push({ key: record.key, revision: record.revision, value });
      }
      if (page.length < 200) {
        const selected = new Map<string, (typeof result)[number]>();
        for (const row of result)
          if (!selected.has(row.value.path) || row.key.startsWith('output/'))
            selected.set(row.value.path, row);
        return [...selected.values()];
      }
      afterKey = page.at(-1)!.key;
    }
  }
  return {
    ...options.extension,
    records: [
      ...(options.extension.records ?? []),
      {
        contentType,
        contentVersion: 1,
        fork: {
          mode: 'rebuild',
          version: '1',
          sourceReads: 'declared',
          onUnsupported: 'reject',
          async prepare(input) {
            const selected = new Map<
              string,
              { record: (typeof input.records)[number]; inherited: boolean }
            >();
            // Inherited anchors predate new branch messages; only selected original
            // execution results may replace them. A mutable head is never copied.
            for (const record of input.records)
              if (
                record.key.startsWith('output-inherited/') &&
                decode(record.value).state === 'inherited'
              )
                selected.set(decode(record.value).name, { record, inherited: true });
            for (const message of input.selectedMessages)
              for (const executionId of message.sourceIds) {
                const record = input.records.find(
                  (row) => row.key === `output-operation/${executionId}`,
                );
                if (record && decode(record.value).state === 'saved')
                  selected.set(decode(record.value).name, { record, inherited: false });
              }
            return [...selected.values()].flatMap(({ record, inherited }) => {
              const value = decode(record.value);
              const path = value.path.replace(
                `/${digest(input.sourceSessionId)}/outputs/`,
                `/${digest(input.targetSessionId)}/outputs/`,
              );
              if (path === value.path) throw new AgentError('output_file_scope_denied');
              const reference = value.snapshot as unknown as import('../extensions').ArtifactRef;
              if (reference.scope?.kind !== 'execution' || reference.scope.id !== value.executionId)
                throw new AgentError('output_file_source_unavailable');
              const output = {
                key: keyOf(path),
                contentType,
                contentVersion: 1,
                value: { ...value, path, state: 'inherited' } as unknown as Json,
                readonlySources: [
                  inherited
                    ? {
                        kind: 'inherited' as const,
                        anchorKey: record.key,
                        executionId: value.executionId,
                        artifactRefIds: [reference.id],
                      }
                    : {
                        kind: 'execution' as const,
                        executionKind: 'tool' as const,
                        executionId: value.executionId,
                        artifactRefIds: [reference.id],
                      },
                ],
              };
              return [{ ...output, key: `output-inherited/${digest(path)}` }];
            });
          },
        },
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'name', 'state', 'executionId', 'snapshot'],
          properties: {
            path: { type: 'string' },
            name: { type: 'string' },
            state: { enum: ['pending', 'saved', 'inherited'] },
            executionId: { type: 'string' },
            snapshot: { type: ['object', 'null'] },
          },
        },
      },
    ],
    queries: [
      ...(options.extension.queries ?? []),
      {
        id: 'files.output-source',
        version: '1',
        description: 'Resolve the sealed read-only Fork output source',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: { key: { type: 'string' } },
        },
        outputSchema: { type: 'array', items: { type: 'object' } },
        async execute(input: Json, context: ReadContext) {
          const key = (input as { key: string }).key;
          if (!key.startsWith('output-inherited/'))
            throw new AgentError('output_file_scope_denied');
          const record = await context.records.get(key);
          if (!record || decode(record.value).state !== 'inherited')
            throw new AgentError('output_file_source_unavailable');
          const value = decode(record.value);
          const projection = await context.openForkSourceProjection?.(key);
          const execution = await projection?.getExecution(value.executionId);
          const reference = value.snapshot as unknown as import('../extensions').ArtifactRef;
          if (
            !execution ||
            !projection?.sources.some(
              (source) =>
                source.executionId === execution.id &&
                source.artifactRefs.some(
                  (ref) =>
                    ref.id === reference.id &&
                    ref.mediaType === reference.mediaType &&
                    ref.size === reference.size &&
                    canonicalJson(ref.scope as unknown as Json) ===
                      canonicalJson(reference.scope as unknown as Json),
                ),
            )
          )
            throw new AgentError('output_file_source_unavailable');
          return [
            {
              extensionId: options.extension.id,
              contentType,
              contentVersion: 1,
              summary: value.name,
              payload: {
                revision: record.revision,
                executionId: execution.id,
                sessionId: execution.sessionId,
                reference: reference as unknown as Json,
              },
              artifactRefs: [reference],
              actions: [],
            },
          ];
        },
      },
      {
        id: 'files.outputs',
        version: '1',
        description:
          'Read registered editable output files; pass an exact path to resolve any current file',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { path: { type: 'string' } },
        },
        outputSchema: { type: 'array', items: { type: 'object' } },
        async execute(input: Json, context: ReadContext) {
          const rows = await records(context, (input as { path?: string }).path);
          return [
            {
              extensionId: options.extension.id,
              contentType,
              contentVersion: 1,
              summary:
                rows.length > 200
                  ? 'First 200 output files; resolve further files by exact path'
                  : 'Session output files',
              payload: rows.slice(0, 200).map((record) => ({
                ...record,
                path: join(profile, ...record.value.path.split('/')),
              })) as unknown as Json,
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
  };
}
