import { expect, test } from 'bun:test';
import { RuntimeClientStartupError } from '@kite-ai/runtime-client';
import {
  encodeServiceStartupDiagnostic,
  encodeServiceStartupProgress,
  formatServiceStartupReport,
  parseServiceStartupDiagnostic,
  parseServiceStartupProgress,
  SERVICE_STARTUP_DIAGNOSTIC_PREFIX,
  SERVICE_STARTUP_PHASES,
  SERVICE_STARTUP_PROGRESS_PREFIX,
} from '../src/service-startup-diagnostic';

test('fixed progress phases accept complete records and reject hidden fields or arbitrary text', () => {
  for (const phase of SERVICE_STARTUP_PHASES) {
    const line = encodeServiceStartupProgress(phase);
    expect(parseServiceStartupProgress(line)).toEqual({ phase });
    expect(parseServiceStartupProgress(line.trimEnd())).toEqual({ phase });
  }
  for (const suffix of [
    '{"phase":"publishing","path":"/private/secret"}',
    '{"phase":"unrecognized"}',
    '{"phase":{}}',
    '{"phase":"publishing"}\\nraw stderr',
    '{"phase":',
  ])
    expect(parseServiceStartupProgress(SERVICE_STARTUP_PROGRESS_PREFIX + suffix)).toBeUndefined();
  expect(parseServiceStartupProgress('raw stderr')).toBeUndefined();
  expect(parseServiceStartupProgress('x'.repeat(200))).toBeUndefined();
  const waiting = parseServiceStartupProgress(encodeServiceStartupProgress('waiting_for_store'))!;
  expect(waiting).toEqual({ phase: 'waiting_for_store' });
  expect(
    new RuntimeClientStartupError({
      code: 'store_busy',
      actualSchema: 10,
      expectedSchema: 10,
      stage: waiting.phase,
    }).stage,
  ).toBe('waiting_for_store');
});

test('stage and new storage failures survive encoding without copying private error details', () => {
  for (const code of [
    'store_access_denied',
    'store_corrupt',
    'store_preparation_cancelled',
  ] as const) {
    const line = encodeServiceStartupDiagnostic({
      name: 'KiteSessionStoreOpenError',
      code,
      stage: 'inspecting',
      message: '/private/secret',
      cause: new Error('password'),
      compatibility: { actualSchema: 10, expectedSchema: 10, actualEpoch: 'secret' },
    })!;
    const diagnostic = parseServiceStartupDiagnostic(line)!;
    expect(diagnostic).toEqual({ code, stage: 'inspecting', actualSchema: 10, expectedSchema: 10 });
    const error = new RuntimeClientStartupError(diagnostic);
    expect(error.diagnosticCode).toBe(code);
    expect(error.stage).toBe('inspecting');
    expect(line).not.toContain('private');
    expect(line).not.toContain('password');
    expect(line).not.toContain('epoch');
    const report = JSON.parse(formatServiceStartupReport(diagnostic));
    expect(report.code).toBe(code);
    expect(report.stage).toBe('inspecting');
    expect(report.actions).toContain('save_diagnostic');
    expect(Object.keys(report).sort()).toEqual([
      'actions',
      'actualSchema',
      'code',
      'expectedSchema',
      'retryable',
      'schema',
      'stage',
    ]);
  }
});

test('legacy diagnostics remain valid; malformed categories and stage fields never escape parsing', () => {
  const legacy = { code: 'store_busy', actualSchema: null, expectedSchema: null } as const;
  expect(
    parseServiceStartupDiagnostic(SERVICE_STARTUP_DIAGNOSTIC_PREFIX + JSON.stringify(legacy)),
  ).toEqual(legacy);
  for (const extra of [
    { stage: 'secret/path' },
    { path: 'secret' },
    { stage: null },
    { code: { toString: 'store_busy' } },
  ]) {
    expect(
      parseServiceStartupDiagnostic(
        SERVICE_STARTUP_DIAGNOSTIC_PREFIX + JSON.stringify({ ...legacy, ...extra }),
      ),
    ).toBeUndefined();
  }
  expect(() => formatServiceStartupReport({ ...legacy, path: 'secret' } as never)).toThrow();
  expect(() => new RuntimeClientStartupError({ ...legacy, stage: 'secret' } as never)).toThrow();
  expect(
    parseServiceStartupDiagnostic(
      SERVICE_STARTUP_DIAGNOSTIC_PREFIX + JSON.stringify({ ...legacy, stage: 'waiting_for_store' }),
    ),
  ).toEqual({ ...legacy, stage: 'waiting_for_store' });
});
