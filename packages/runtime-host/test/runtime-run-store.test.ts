import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { parseRuntimeStoredCommandReceipt } from '../src';
import {
  assertRuntimeRunStartResourceResult,
  assertRuntimeStoredCommandResourceResult,
  assertRuntimeStoredRun,
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  decodeRuntimeRunTerminal,
  encodeRuntimeRunTerminal,
  type RuntimeStoredRun,
} from '../src/storage';

describe('neutral Runtime Run storage contract', () => {
  test('validates queued, active and terminal rows without a concrete Store dependency', () => {
    const queued = run();
    const running: RuntimeStoredRun = {
      ...queued,
      status: 'running',
      lastRevision: 2,
      startedAtMs: 110,
    };
    const failed: RuntimeStoredRun = {
      ...running,
      status: 'failed',
      lastRevision: 3,
      finishedAtMs: 120,
      terminal: {
        reasonCode: 'model_unavailable',
        safeRetry: true,
        recoveryEntry: 'retry',
        outcomeId: 'outcome-1',
      },
    };
    expect(() => assertRuntimeStoredRun(queued)).not.toThrow();
    expect(() => assertRuntimeStoredRun(running)).not.toThrow();
    expect(() => assertRuntimeStoredRun(failed)).not.toThrow();
    expect(decodeRuntimeRunTerminal(encodeRuntimeRunTerminal(failed.terminal!))).toEqual(
      failed.terminal!,
    );
  });

  test('rejects lifecycle, timestamp, origin and terminal shape drift', () => {
    expect(() => assertRuntimeStoredRun({ ...run(), lastRevision: 0 })).toThrow('last revision');
    expect(() => assertRuntimeStoredRun({ ...run(), status: 'running' })).toThrow('started time');
    expect(() =>
      assertRuntimeStoredRun({
        ...run(),
        status: 'failed',
        startedAtMs: 110,
        finishedAtMs: 109,
      }),
    ).toThrow();
    expect(() => assertRuntimeStoredRun({ ...run(), originSessionId: 'source' })).toThrow(
      'origin identity',
    );
    expect(() =>
      decodeRuntimeRunTerminal(
        '{"reason_code":"failed","safe_retry":false,"recovery_entry":"retry","extra":true}',
      ),
    ).toThrow('not closed');
  });

  test('binds an optional canonical resource result to the stored receipt contract', () => {
    const json = '{"run_id":"run-1","schema":"kite.runtime.run-result.v1"}';
    const resourceResult = {
      schema: 'kite.runtime.run-result.v1',
      json,
      digest: createHash('sha256').update(json).digest('hex'),
    };
    expect(() => assertRuntimeStoredCommandResourceResult(resourceResult)).not.toThrow();
    const receipt = createRuntimeStoredCommandReceipt(
      {
        scopeSessionId: 'session-1',
        commandId: 'command-1',
        requestDigest: 'a'.repeat(64),
        targetSessionId: 'session-1',
        committedAt: 100,
        resourceResult,
      },
      1,
    );
    expect(receipt.resourceResult).toEqual(resourceResult);
    expect(parseRuntimeStoredCommandReceipt(receipt)).toMatchObject({
      status: 'applied',
      revision: 1,
    });

    expect(() =>
      assertRuntimeStoredCommandResourceResult({ ...resourceResult, json: '{ "schema": "x" }' }),
    ).toThrow('not canonical');
    expect(() =>
      assertRuntimeStoredCommandResourceResult({ ...resourceResult, digest: 'not-a-digest' }),
    ).toThrow('digest');
  });

  test('derives the original queued resource only from immutable Run creation facts', () => {
    const queued = run();
    const original = createRuntimeRunStartResourceResult({
      ...queued,
      status: 'completed',
      lastRevision: 3,
      startedAtMs: 110,
      finishedAtMs: 120,
      terminal: { reasonCode: 'completed', safeRetry: false, recoveryEntry: 'none' },
    });
    expect(JSON.parse(original.json)).toMatchObject({
      run: {
        runId: 'run-1',
        status: 'queued',
        createdRevision: 1,
        lastRevision: 1,
      },
    });
    expect(() => assertRuntimeRunStartResourceResult(original, queued)).not.toThrow();
    expect(() =>
      assertRuntimeRunStartResourceResult(
        {
          ...original,
          json: original.json.replace('run-1', 'run-other'),
          digest: createHash('sha256')
            .update(original.json.replace('run-1', 'run-other'))
            .digest('hex'),
        },
        queued,
      ),
    ).toThrow('does not match');
  });
});

function run(): RuntimeStoredRun {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    startCommandId: 'command-1',
    phase: 'building',
    status: 'queued',
    createdRevision: 1,
    lastRevision: 1,
    createdAtMs: 100,
  };
}
