import { expect, test } from 'bun:test';
import { saveStartupDiagnosticReport } from '../electron/runtime/startup-report';

test('canceling the native save dialog does not write a diagnostic', async () => {
  let writes = 0;
  const saved = await saveStartupDiagnosticReport(
    '{"code":"store_busy"}',
    async () => null,
    async () => {
      writes++;
    },
  );
  expect(saved).toBe(false);
  expect(writes).toBe(0);
});

test('the native saver requires a captured diagnostic and writes only after selection', async () => {
  let selected = false;
  await expect(
    saveStartupDiagnosticReport(
      null,
      async () => {
        selected = true;
        return '/tmp/report.json';
      },
      async () => undefined,
    ),
  ).rejects.toThrow('没有可保存的启动诊断');
  expect(selected).toBe(false);
  const writes: Array<[string, string]> = [];
  expect(
    await saveStartupDiagnosticReport(
      '{"code":"store_busy"}',
      async () => '/tmp/report.json',
      async (path, report) => {
        writes.push([path, report]);
      },
    ),
  ).toBe(true);
  expect(writes).toEqual([['/tmp/report.json', '{"code":"store_busy"}']]);
});
