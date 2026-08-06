import { fileURLToPath } from 'node:url';
import {
  encodeLiveIsolatedTransportFrameV1,
  LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1,
  LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1,
  parseLiveIsolatedTransportFrameLineV1,
  parseLiveIsolatedTransportParentFrameV1,
} from './live-isolated-transport-protocol-v1';

/**
 * Fixed test-only launcher for the POSIX process-group reaping test. It is
 * selected only by a closed test enum inside `live-model-transport-v1.ts`;
 * production child code has no `Bun.spawn` capability.
 */
const DESCENDANT_ENTRYPOINT_V1 = fileURLToPath(
  new URL('./live-isolated-transport-hang-descendant-child-v1.ts', import.meta.url),
);
const EXITING_DESCENDANT_ENTRYPOINT_V1 = fileURLToPath(
  new URL('./live-isolated-transport-exit-descendant-child-v1.ts', import.meta.url),
);

let nonce: string | undefined;
let spawned = false;

function fail(): never {
  process.exitCode = 1;
  process.exit();
}

function ready(): void {
  if (!nonce) fail();
  const frame = encodeLiveIsolatedTransportFrameV1({
    schema: LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1,
    version: LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1,
    kind: 'ready',
    nonce,
  });
  if (!frame) fail();
  process.stdout.write(`${frame}\n`);
}

function emitLeaderExitResult(request: {
  readonly phase: 'aq8' | 'summary' | 'primary' | 'test';
  readonly promptDigest: `sha256:${string}`;
}): void {
  if (!nonce) fail();
  const generation =
    request.phase === 'summary'
      ? { kind: 'accepted_summary' as const }
      : request.phase === 'primary'
        ? { kind: 'accepted_primary' as const }
        : undefined;
  const frame = encodeLiveIsolatedTransportFrameV1({
    schema: LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1,
    version: LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1,
    kind: 'result',
    nonce,
    phase: request.phase,
    promptDigest: request.promptDigest,
    outcome: 'success',
    providerDispatchCount: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    ...(generation ? { generation } : {}),
  });
  if (!frame) fail();
  process.stdout.write(`${frame}\n`, () => process.exit(0));
}

async function readFrames(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const parsed = parseLiveIsolatedTransportParentFrameV1(
          parseLiveIsolatedTransportFrameLineV1(pending.slice(0, index)),
        );
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
        if (!parsed) fail();
        if (parsed.kind === 'init') {
          if (nonce !== undefined) fail();
          nonce = parsed.nonce;
          ready();
          continue;
        }
        if (!nonce || parsed.nonce !== nonce || parsed.kind !== 'dispatch' || spawned) fail();
        spawned = true;
        if (parsed.request.testMode === 'leader_exits_with_descendant_then_exit') {
          // The fixed descendant writes a marker inside the synthetic scratch,
          // then exits. The leader exits first, so the parent must quarantine
          // instead of signalling an old process-group identifier.
          Bun.spawn([process.execPath, '--no-env-file', EXITING_DESCENDANT_ENTRYPOINT_V1], {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
          });
          emitLeaderExitResult(parsed.request);
          return;
        }
        // The descendant deliberately has no inherited pipe handles. It stays
        // in this process group so the parent must prove group reaping.
        Bun.spawn([process.execPath, '--no-env-file', DESCENDANT_ENTRYPOINT_V1], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
        await new Promise<never>(() => undefined);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

void readFrames().catch(fail);
