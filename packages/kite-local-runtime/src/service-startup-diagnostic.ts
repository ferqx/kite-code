/** The only Service stderr content a native client may turn into a startup message. */
export const SERVICE_STARTUP_DIAGNOSTIC_PREFIX = 'KITE_SERVICE_STARTUP_ERROR_V1:';
export const MAX_SERVICE_STARTUP_STDERR_BYTES = 4_096;

export type ServiceStartupDiagnostic = Readonly<{
  code: 'store_incompatible' | 'store_migration_required' | 'store_busy';
  actualSchema: number | null;
  expectedSchema: number | null;
}>;

export function serviceStartupDiagnostic(error: unknown): ServiceStartupDiagnostic | undefined {
  if (!isRecord(error) || error.name !== 'KiteSessionStoreOpenError') return undefined;
  if (
    error.code !== 'store_incompatible' &&
    error.code !== 'store_migration_required' &&
    error.code !== 'store_busy'
  )
    return undefined;
  const compatibility = isRecord(error.compatibility) ? error.compatibility : undefined;
  return {
    code: error.code,
    actualSchema: schema(compatibility?.actualSchema),
    expectedSchema: schema(compatibility?.expectedSchema),
  };
}

export function encodeServiceStartupDiagnostic(error: unknown): string | undefined {
  const diagnostic = serviceStartupDiagnostic(error);
  return diagnostic
    ? `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}\n`
    : undefined;
}

export function parseServiceStartupDiagnostic(
  stderr: string,
): ServiceStartupDiagnostic | undefined {
  for (const line of stderr.split(/\r?\n/u)) {
    if (!line.startsWith(SERVICE_STARTUP_DIAGNOSTIC_PREFIX)) continue;
    if (line.length > 256) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(SERVICE_STARTUP_DIAGNOSTIC_PREFIX.length));
    } catch {
      return undefined;
    }
    if (!isRecord(value)) return undefined;
    if (Object.keys(value).sort().join(',') !== 'actualSchema,code,expectedSchema')
      return undefined;
    if (
      value.code !== 'store_incompatible' &&
      value.code !== 'store_migration_required' &&
      value.code !== 'store_busy'
    )
      return undefined;
    if (!validSchema(value.actualSchema) || !validSchema(value.expectedSchema)) return undefined;
    return value as ServiceStartupDiagnostic;
  }
  return undefined;
}

export function describeServiceStartupFailure(
  diagnostic: ServiceStartupDiagnostic | undefined,
  exitCode: number | null,
): string {
  if (diagnostic) {
    const code = diagnostic.code.toUpperCase();
    if (diagnostic.code === 'store_busy') return `${code}：会话存储正忙，请稍后重试。`;
    const actual = diagnostic.actualSchema === null ? '未知' : String(diagnostic.actualSchema);
    const expected =
      diagnostic.expectedSchema === null ? '未知' : String(diagnostic.expectedSchema);
    return `${code}：会话存储格式不兼容（当前 schema ${actual}，程序预期 ${expected}）。`;
  }
  return `配套服务启动失败（退出码 ${exitCode ?? '未知'}）。`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSchema(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function schema(value: unknown): number | null {
  return validSchema(value) ? value : null;
}
