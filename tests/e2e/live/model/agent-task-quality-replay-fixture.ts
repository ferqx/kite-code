import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { comparisonWireRequestMatches } from './agent-task-quality-presentation-ab-fixture';
import type { createLiveModelFixture } from './live-model-fixture';

/** Original live bytes only. This branch never resolves configuration or credentials. */
export function loadTaskQualityReplay(root: string) {
  const read = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const original = read('result.json');
  const requests = read('original-requests.json') as ModelRequest[];
  const canonicalBytes = readFileSync(join(root, 'canonical-model-evidence.json'));
  if (createHash('sha256').update(canonicalBytes).digest('hex') !== original.canonical?.sha256)
    throw Error('replay_original_canonical_hash_mismatch');
  const records = JSON.parse(canonicalBytes.toString('utf8')) as {
    scope: { expectedStoreId: string; sessionId: string; subjectId: string; executionId: string };
    execution: Record<string, unknown>;
    input: { request: ModelRequest };
  }[];
  const metadata = read('model-binding.json') as Record<string, unknown>;
  const wireRequests = read('wire-requests.json') as Awaited<
    ReturnType<typeof createLiveModelFixture>
  >['wireRequests'];
  if (
    original.canonical?.complete !== true ||
    !requests.length ||
    records.length !== requests.length
  )
    throw Error('replay_original_canonical_incomplete');
  for (const request of requests) {
    const matching = records.filter((record) => record.execution.id === request.requestId);
    if (matching.length !== 1 || !isDeepStrictEqual(matching[0]!.input.request, request))
      throw Error('replay_canonical_and_actual_request_mismatch');
    if (!wireRequests.some((wire) => wire.requestId === request.requestId))
      throw Error('replay_request_wire_missing');
  }
  for (const wire of wireRequests) {
    const request = requests.find((request) => request.requestId === wire.requestId);
    if (
      !request ||
      wire.bytes !== Buffer.byteLength(wire.body) ||
      !comparisonWireRequestMatches(request, wire.body, metadata.protocol)
    )
      throw Error('replay_original_wire_full_body_mismatch');
  }
  const model: ModelAdapter = {
    stream() {
      throw Error('provider_forbidden_in_offline_regrade');
    },
  };
  const fixture: Awaited<ReturnType<typeof createLiveModelFixture>> = {
    model,
    modelId: requests[0]!.modelId,
    signal: new AbortController().signal,
    requests,
    calls: [],
    usage: original.metrics.usage,
    metadata,
    wireRequests,
    wire: original.metrics.httpStatuses.map((status: number) => ({ status, tools: [] })),
  };
  return { fixture, records, original };
}
