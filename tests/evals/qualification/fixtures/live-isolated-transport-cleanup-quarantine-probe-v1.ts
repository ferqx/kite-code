import { liveIsolatedTransportPromptDigestV1 } from '../../../../scripts/evals/qualification/live-isolated-transport-protocol-v1';
import {
  liveIsolatedTransportDeadlineV1,
  type RunLiveIsolatedTransportInputV1,
} from '../../../../scripts/evals/qualification/live-isolated-transport-v1';
import { runLiveIsolatedTransportV1 } from '../../../../scripts/evals/qualification/live-model-transport-v1';

const mode = process.argv[2];
if (
  mode !== 'fixed_spawn_failure_with_cleanup_failure' &&
  mode !== 'fixed_setup_failure_with_cleanup_failure'
) {
  process.exitCode = 1;
} else {
  const deadline = liveIsolatedTransportDeadlineV1(1_000);
  if (!deadline) {
    process.exitCode = 1;
  } else {
    const input: RunLiveIsolatedTransportInputV1 = {
      fixture: {
        fixtureId: 'qualification-l3-sealed-synthetic-fixture-v1',
        fixtureDigest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode('{"schema":"sealed-synthetic-fixture-v1"}\n'),
      },
      request: {
        operation: 'test',
        routeAlias: 'qualification-qwen3.6-flash',
        model: 'qwen3.6-flash',
        phase: 'summary',
        maxInputTokens: 100,
        maxOutputTokens: 100,
        promptDigest: liveIsolatedTransportPromptDigestV1({ operation: 'test', phase: 'summary' }),
      },
      cutoffAtMs: deadline.cutoffAtMs,
      exitDeadlineAtMs: deadline.exitDeadlineAtMs,
    };
    const first = await runLiveIsolatedTransportV1(input, { testMode: mode });
    const second = await runLiveIsolatedTransportV1(input, { testMode: 'return_summary' });
    if (
      first.status !== 'child_failure' ||
      first.dispatched !== 'known_zero' ||
      !first.exitConfirmed ||
      second.status !== 'child_failure' ||
      second.dispatched !== 'known_zero' ||
      !second.exitConfirmed
    ) {
      process.exitCode = 1;
    } else {
      process.stdout.write('isolated_transport_cleanup_quarantine_ok\n');
    }
  }
}
