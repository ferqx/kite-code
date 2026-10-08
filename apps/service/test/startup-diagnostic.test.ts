import { expect, test } from 'bun:test';
import {
  encodeServiceStartupDiagnostic,
  formatServiceStartupReport,
  parseServiceStartupDiagnostic,
  SERVICE_STARTUP_DIAGNOSTIC_PREFIX as prefix,
} from '../src/startup-diagnostic';

test('startup reports rebuild only the actual closed Service classification and phase', () => {
  const diagnostic = { code: 'data_unavailable', stage: 'opening_store' } as const;
  const encoded = encodeServiceStartupDiagnostic(diagnostic);
  expect(parseServiceStartupDiagnostic(`private raw output\n${encoded}`)).toEqual(diagnostic);
  expect(JSON.parse(formatServiceStartupReport(diagnostic))).toEqual({
    schema: 'kite.startup-diagnostic.v1',
    code: 'data_unavailable',
    stage: 'opening_store',
    actualSchema: null,
    expectedSchema: null,
    retryable: true,
    actions: [
      'verify_profile_storage_access',
      'retry_after_resolving_condition',
      'save_diagnostic',
    ],
  });
  for (const value of [
    null,
    [],
    { code: 'data_unavailable' },
    { code: 'private_error', stage: 'opening_store' },
    { code: 'data_unavailable', stage: 'publishing' },
    { ...diagnostic, path: '/private/user' },
    { ...diagnostic, token: 'credential' },
    { ...diagnostic, actualSchema: 1 },
  ]) {
    expect(parseServiceStartupDiagnostic(`${prefix}${JSON.stringify(value)}\n`)).toBeUndefined();
    expect(() => formatServiceStartupReport(value as typeof diagnostic)).toThrow();
  }
  expect(parseServiceStartupDiagnostic(`${prefix}${' '.repeat(321)}{}\n`)).toBeUndefined();
  expect(parseServiceStartupDiagnostic(`${prefix}{\n${encoded}`)).toBeUndefined();
  expect(parseServiceStartupDiagnostic('{"code":"data_unavailable"}\n')).toBeUndefined();
});
