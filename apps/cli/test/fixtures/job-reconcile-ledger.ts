import { readFileSync, writeFileSync } from 'node:fs';
import type { Extension, JobReconcileResult } from '@kite-ai/agent/extensions';

/** An actual external ledger, independent of Core result persistence. */
export function createLedgerExtension(
  ledger: string,
  options: {
    version?: string;
    recovery?: boolean;
    hold?: boolean;
    query?: () => Promise<JobReconcileResult>;
    onStart?: () => void;
    onQuery?: () => void;
  } = {},
): Extension {
  return {
    id: 'fixture.ledger',
    version: '1',
    apiMajor: 1,
    jobs: [
      {
        id: 'ledger.job',
        version: '1',
        description: 'One real ledger effect',
        inputSchema: { type: 'object', additionalProperties: false },
        ...(options.recovery === false
          ? {}
          : {
              recovery: {
                version: options.version ?? '1',
                configuration: { ledger },
              },
            }),
        async start(_input, context) {
          options.onStart?.();
          writeFileSync(
            ledger,
            JSON.stringify({ operation: context.executionId, outcome: 'succeeded' }),
          );
          return { reference: { operation: context.executionId } };
        },
        async *observe() {
          if (options.hold) await new Promise<void>(() => {});
          yield {
            type: 'terminal' as const,
            result: { outcome: 'outcome_unknown' as const, content: 'original_reply_lost' },
            supervision: 'ended' as const,
          };
        },
        async cancel() {
          return { status: 'already_finished' as const };
        },
        async dispose() {},
        async reconcile(reference, context) {
          options.onQuery?.();
          if (options.query) return options.query();
          const actual = JSON.parse(readFileSync(ledger, 'utf8')) as {
            operation: string;
            outcome: string;
          };
          if (
            (reference as { operation?: string }).operation !== actual.operation ||
            actual.operation !== context.executionId
          )
            return { status: 'unavailable', reason: 'ledger_identity_changed' };
          return {
            status: 'observed',
            result: { outcome: 'succeeded', content: 'one ledger effect verified' },
            supervision: 'ended',
            evidence: { operation: actual.operation, source: 'external_ledger' },
          };
        },
      },
    ],
    tools: [
      {
        id: 'ledger.launch',
        version: '1',
        description: 'Launch a controlled ledger job',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          const ref = await context.operations.ensure({
            key: 'once',
            cancellation: 'detached',
            request: { kind: 'job', definitionId: 'ledger.job', definitionVersion: '1', input: {} },
          });
          return { outcome: 'succeeded', content: ref.executionId! };
        },
      },
    ],
  };
}
