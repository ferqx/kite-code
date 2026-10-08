/** The caller supplies only a report derived from a validated Service diagnostic. */
export async function saveStartupDiagnosticReport(
  report: string | null,
  pickPath: () => Promise<string | null>,
  write: (path: string, report: string) => Promise<void>,
): Promise<boolean> {
  if (report === null) throw new Error('当前没有可保存的启动诊断。');
  const path = await pickPath();
  if (path === null) return false;
  await write(path, report);
  return true;
}
