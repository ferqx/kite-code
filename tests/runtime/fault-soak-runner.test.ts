import { describe, expect, test } from 'bun:test';
import { captureBounded, parseRuntimeFaultSoakOptions } from '../../scripts/runtime/run-fault-soak';

describe('runtime fault soak runner', () => {
  test('uses bounded profile defaults and accepts explicit overrides', () => {
    expect(parseRuntimeFaultSoakOptions([])).toMatchObject({
      profile: 'ci',
      iterations: 1,
      seed: 1729,
      perCaseTimeoutMs: 120_000,
    });
    expect(
      parseRuntimeFaultSoakOptions([
        '--profile=qualification',
        '--iterations',
        '9',
        '--seed=23',
        '--timeout-ms',
        '4567',
      ]),
    ).toMatchObject({
      profile: 'qualification',
      iterations: 9,
      seed: 23,
      perCaseTimeoutMs: 4567,
    });
  });

  test('ends output capture when an inherited pipe never reaches EOF', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial output'));
      },
    });
    const abort = new AbortController();
    const startedAt = performance.now();
    setTimeout(() => abort.abort(), 10);

    const output = await captureBounded(stream, abort.signal);

    expect(output).toContain('partial output');
    expect(output).toContain('bounded drain deadline');
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
