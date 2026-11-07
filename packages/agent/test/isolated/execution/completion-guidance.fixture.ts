import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRequest } from '@kite-ai/ai';
import type { Extension } from '../../../src/extensions';
import type { RunConfiguration } from '../../../src/runtime';
import { AgentError } from '../../../src/storage/types';

export function guidanceConfiguration(
  root: string,
  options: {
    owners?: number;
    key?: () => string;
    onModel?: (request: ModelRequest) => void;
    compress?: boolean;
    refresh?: boolean;
  } = {},
): RunConfiguration {
  let calls = 0;
  const extensions: Extension[] = Array.from({ length: options.owners ?? 1 }, (_, index) => ({
    id: `guidance.${index}`,
    version: '1',
    apiMajor: 1,
    records: [{ contentType: 'required', contentVersion: 1, schema: { type: 'object' } }],
    completionGovernance: {
      async prepare() {
        return {
          kind: 'continue',
          key: options.key?.() ?? 'same-fact',
          content: 'Original pending fact',
        };
      },
    },
  }));
  let compressed = false;
  let admissions = 0;
  return {
    modelId: 'fixed',
    snapshot: {
      fixture: 'completion-guidance',
      owners: extensions.length,
      compress: !!options.compress,
    },
    extensions,
    model: {
      async *stream(request) {
        appendFileSync(join(root, 'model-ledger'), `${request.requestId}\n`);
        if (++calls > 8) throw Error('fixture_duplicate_completion_model');
        options.onModel?.(request);
        yield { type: 'text_delta', text: 'Original complete response' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    permissions: {
      async authorize(request) {
        if (options.refresh && request.kind === 'model' && ++admissions === 2)
          throw new AgentError('context_refresh_required');
        return { allowed: true, revision: 'host' };
      },
    },
    async initializeRequirements(input) {
      return Promise.all(
        extensions.map(async (extension) => {
          const read = await input.forExtension(extension.id);
          const key = `run/${input.run.id}/required`;
          const record = await read.records.create({
            key,
            contentType: 'required',
            contentVersion: 1,
            value: { required: true },
          });
          return {
            extensionId: extension.id,
            definitionVersion: '1',
            requirementId: 'required',
            recordKey: key,
            revision: record.revision,
            phase: 'completion' as const,
            sessionId: input.session.id,
            runId: input.run.id,
          };
        }),
      );
    },
    conditions: {
      async evaluate(refs, _phase, context) {
        return Promise.all(
          refs.map(async (requirement) => {
            const read = await context!.forRequirement(requirement);
            const record = await read.records.get(requirement.recordKey);
            return {
              requirement,
              recordRevision: record!.revision,
              outcome: 'unsatisfied' as const,
              evidence: { unapproved: true },
            };
          }),
        );
      },
    },
    ...(options.compress
      ? {
          compressor: {
            id: 'guidance.compressor',
            version: '1',
            async shouldCompress(input: { messages: readonly { content: string }[] }) {
              if (
                compressed ||
                !input.messages.some((message) => message.content.includes('completion_diagnostic'))
              )
                return false;
              compressed = true;
              return true;
            },
            async prepare() {
              return { instructions: 'Summarize original context', snapshot: {} };
            },
          },
        }
      : {}),
  };
}
