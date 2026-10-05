import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineExtension, type Json } from '@kite-ai/agent/extensions';

export function factory(
  version: string,
  amount: number,
  asset: string,
  root: string,
  scope: string,
) {
  const fd = openSync(asset, 'r');
  let closed = false;
  const event = (kind: string, extra: Json = null) =>
    appendFileSync(join(root, 'lifecycle'), `${JSON.stringify({ kind, version, scope, extra })}\n`);
  const marker = () => readFileSync(fd, 'utf8');
  // readFileSync(fd) consumes its offset: keep the original asset bytes while
  // fstat verifies the held descriptor has not been prematurely disposed.
  const bytes = marker();
  const held = () => {
    if (closed || fstatSync(fd).size !== Buffer.byteLength(bytes))
      throw Error('original_asset_closed');
    return bytes;
  };
  event('scope-open', bytes);
  const extension = defineExtension({
    id: 'fixture.upgrade',
    version,
    apiMajor: 1,
    records: [1, ...(version === '2' ? [2] : [])].map((contentVersion) => ({
      contentType: 'fixture.upgrade.record',
      contentVersion,
      schema: { type: 'object' },
    })),
    tools: [
      {
        id: 'fixture.upgrade.work',
        version,
        description: 'Independent versioned upgrade fixture',
        inputSchema: {
          type: 'object',
          properties: { mode: { enum: ['work', 'future', 'inspect'] } },
          required: ['mode'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const mode = (input as { mode: string }).mode;
          if (mode === 'inspect') {
            const original = await context.records.get('future');
            if (!original) throw Error('future_record_missing');
            let refusal = '';
            try {
              await context.records.write({
                key: 'future',
                expectedRevision: original.revision,
                contentType: 'fixture.upgrade.record',
                contentVersion: 1,
                value: { overwrite: true },
              });
            } catch (error) {
              refusal = (error as { code?: string }).code ?? String(error);
            }
            if (refusal !== 'extension_record_format_unavailable')
              throw Error(`future_not_refused:${refusal}`);
            return {
              outcome: 'succeeded',
              content: 'local unsupported future preserved',
              details: {
                refusal,
                originalRevision: original.revision,
                originalValue: original.value,
              },
            };
          }
          if (mode === 'future') {
            await context.records.write({
              key: 'future',
              expectedRevision: null,
              contentType: 'fixture.upgrade.record',
              contentVersion: 2,
              executable: true,
              value: { marker: held(), future: { unseen: 'preserve exact V2 bytes' } },
            });
            return { outcome: 'succeeded', content: 'V2 future saved' };
          }
          const operation = await context.operations.ensure({
            key: 'original',
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: 'fixture.upgrade.job',
              definitionVersion: version,
              input: { scope },
            },
          });
          await context.records.write({
            key: 'original',
            expectedRevision: null,
            contentType: 'fixture.upgrade.record',
            contentVersion: 1,
            executable: true,
            value: {
              operation: { ...operation },
              version,
              marker: held(),
              sourceExecutionId: context.executionId,
            },
          });
          return { outcome: 'succeeded', content: `version ${version} detached original job` };
        },
      },
    ],
    jobs: [
      {
        id: 'fixture.upgrade.job',
        version,
        description: 'Held original artifact work',
        inputSchema: { type: 'object' },
        async start(_input, context) {
          event('job-start', context.executionId);
          return { reference: { executionId: context.executionId } };
        },
        async *observe(handle) {
          const deadline = Date.now() + 20000;
          while (!existsSync(join(root, `release-${scope}`))) {
            if (Date.now() > deadline) throw Error('owned_upgrade_barrier_expired');
            await Bun.sleep(5);
          }
          const result = {
            version,
            amount,
            marker: held(),
            executionId: (handle.reference as { executionId: string }).executionId,
          };
          appendFileSync(join(root, 'effects'), `${JSON.stringify(result)}\n`);
          event('job-terminal', result);
          yield {
            type: 'terminal' as const,
            supervision: 'ended' as const,
            result: { outcome: 'succeeded' as const, content: JSON.stringify(result) },
          };
        },
        async cancel() {
          return { status: 'unknown' as const };
        },
        async dispose(handle) {
          event('job-dispose', handle.reference);
        },
      },
    ],
  });
  return {
    extension,
    async dispose() {
      if (closed) throw Error('scope_disposed_twice');
      closed = true;
      closeSync(fd);
      event('scope-dispose');
    },
  };
}
