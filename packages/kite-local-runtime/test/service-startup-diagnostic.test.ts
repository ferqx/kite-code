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
  SERVICE_STORE_ADMISSION_REASONS,
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

test('same-build preparation retry suppression has a fixed non-retryable diagnostic', () => {
  const line = encodeServiceStartupDiagnostic({
    name: 'KiteSessionStoreOpenError',
    code: 'store_preparation_retry_blocked',
    stage: 'preparing',
    message: '/private/secret',
  })!;
  const diagnostic = parseServiceStartupDiagnostic(line)!;
  expect(diagnostic).toEqual({
    code: 'store_preparation_retry_blocked',
    stage: 'preparing',
    actualSchema: null,
    expectedSchema: null,
  });
  expect(line).not.toContain('/private/secret');
  const report = JSON.parse(formatServiceStartupReport(diagnostic));
  expect(report.retryable).toBe(false);
  expect(report.actions).toEqual(['use_updated_version_or_recovery', 'save_diagnostic']);
  expect(new RuntimeClientStartupError(diagnostic).message).toContain('不会再次复制');
});

test('unclassified reconciliation failure does not recommend a same-build retry', () => {
  const line = encodeServiceStartupDiagnostic({
    name: 'KiteSessionStoreOpenError',
    code: 'store_history_reconciliation_required',
    stage: 'preparing',
    message: '/private/secret',
  })!;
  const diagnostic = parseServiceStartupDiagnostic(line)!;
  const report = JSON.parse(formatServiceStartupReport(diagnostic));
  expect(report.retryable).toBe(false);
  expect(report.actions).toEqual(['use_updated_version_or_recovery', 'save_diagnostic']);
  expect(new RuntimeClientStartupError(diagnostic).message).toContain('不会重复建立备份');
  expect(line).not.toContain('/private/secret');
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

test('admission diagnostics expose only fixed reasons and actions', () => {
  for (const admissionReason of SERVICE_STORE_ADMISSION_REASONS) {
    const line = encodeServiceStartupDiagnostic({
      name: 'KiteSessionStoreOpenError',
      code: 'store_admission_failed',
      admissionReason,
      stage: 'acquiring_maintenance',
      cause: new Error('secret-path and credential'),
      message: 'secret-path',
    })!;
    const diagnostic = parseServiceStartupDiagnostic(line)!;
    expect(diagnostic).toEqual({
      code: 'store_admission_failed',
      admissionReason,
      stage: 'acquiring_maintenance',
      actualSchema: null,
      expectedSchema: null,
    });
    expect(line).not.toContain('secret-path');
    expect(line).not.toContain('credential');
    const client = new RuntimeClientStartupError(diagnostic);
    expect(client.admissionReason).toBe(admissionReason);
    expect(client.message).not.toContain('secret-path');
    const report = JSON.parse(formatServiceStartupReport(diagnostic));
    expect(report.admissionReason).toBe(admissionReason);
    expect(report.retryable).toBe(false);
    expect(report.actions).toContain('save_diagnostic');
    expect(report.actions).not.toContain('retry_after_resolving_condition');
  }
  const base = { code: 'store_admission_failed', actualSchema: null, expectedSchema: null };
  for (const extra of [
    {},
    { admissionReason: 'secret-path' },
    { admissionReason: null },
    { admissionReason: 'desktop_parent_unverified', path: '/private/secret' },
  ]) {
    const diagnostic = { ...base, ...extra };
    expect(
      parseServiceStartupDiagnostic(SERVICE_STARTUP_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic)),
    ).toBeUndefined();
    expect(() => new RuntimeClientStartupError(diagnostic as never)).toThrow();
  }
  const busyWithReason = {
    code: 'store_busy',
    actualSchema: null,
    expectedSchema: null,
    admissionReason: 'desktop_parent_unverified',
  };
  expect(
    parseServiceStartupDiagnostic(
      SERVICE_STARTUP_DIAGNOSTIC_PREFIX + JSON.stringify(busyWithReason),
    ),
  ).toBeUndefined();
  expect(() => new RuntimeClientStartupError(busyWithReason as never)).toThrow();
});
