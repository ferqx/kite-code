import { SessionLogWriter } from '@/core/session-logger/writer';

const boundedPolicy =
  process.env.KITE_TEST_BOUNDED_POLICY === '1'
    ? {
        version: 1 as const,
        mode: 'metadata' as const,
        retentionDays: 7,
        maxTotalBytes: 1024,
        maxSessionBytes: 1024,
        includeReasoning: false as const,
        includeFileContent: false as const,
        includeToolContent: false as const,
      }
    : undefined;

const writer = new SessionLogWriter('tui', 'cross-process-thread', 'events', undefined, undefined, {
  policy: boundedPolicy,
  heartbeatIntervalMs: 0,
});

process.stdout.write('lease-acquired\n');
await new Promise<void>((resolve) => {
  process.once('SIGTERM', resolve);
});
await writer.finalize();
