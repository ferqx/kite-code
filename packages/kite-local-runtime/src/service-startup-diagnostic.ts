/** Only bounded, whitelisted Service stderr records may cross into a client. */
export const SERVICE_STARTUP_DIAGNOSTIC_PREFIX = 'KITE_SERVICE_STARTUP_ERROR_V1:';
export const SERVICE_STARTUP_PROGRESS_PREFIX = 'KITE_SERVICE_STARTUP_PROGRESS_V1:';
export const MAX_SERVICE_STARTUP_STDERR_BYTES = 4_096;

export const SERVICE_STARTUP_PHASES = [
  'inspecting',
  'acquiring_maintenance',
  'waiting_for_store',
  'preparing',
  'publishing',
  'ready',
] as const;
export type ServiceStartupPhase = (typeof SERVICE_STARTUP_PHASES)[number];
export type ServiceStartupProgress = Readonly<{ phase: ServiceStartupPhase }>;
export const SERVICE_STORE_ADMISSION_REASONS = [
  'unsupported_platform',
  'desktop_identity_mismatch',
  'paired_manifest_mismatch',
  'desktop_parent_unverified',
  'source_identity_mismatch',
  'source_build_mismatch',
  'source_parent_unverified',
  'installed_identity_mismatch',
  'release_selection_busy_or_unsafe',
  'installed_parent_unverified',
  'installed_process_inspection_incomplete',
  'legacy_process_inspection_incomplete',
  'admission_unverified',
] as const;
export type ServiceStoreAdmissionReason = (typeof SERVICE_STORE_ADMISSION_REASONS)[number];
export type ServiceStartupDiagnostic = Readonly<{
  code:
    | 'store_incompatible'
    | 'store_migration_required'
    | 'store_insufficient_space'
    | 'store_access_denied'
    | 'store_corrupt'
    | 'store_preparation_cancelled'
    | 'store_busy'
    | 'store_admission_failed'
    | 'store_preparation_retry_blocked'
    | 'store_history_reconciliation_required';
  actualSchema: number | null;
  expectedSchema: number | null;
  stage?: ServiceStartupPhase;
  admissionReason?: ServiceStoreAdmissionReason;
}>;
const CODES = new Set([
  'store_incompatible',
  'store_migration_required',
  'store_insufficient_space',
  'store_access_denied',
  'store_corrupt',
  'store_preparation_cancelled',
  'store_busy',
  'store_admission_failed',
  'store_preparation_retry_blocked',
  'store_history_reconciliation_required',
]);

export function serviceStartupDiagnostic(error: unknown): ServiceStartupDiagnostic | undefined {
  if (
    !isRecord(error) ||
    error.name !== 'KiteSessionStoreOpenError' ||
    typeof error.code !== 'string' ||
    !CODES.has(error.code)
  )
    return undefined;
  const compatibility = isRecord(error.compatibility) ? error.compatibility : undefined;
  const admissionReason = error.admissionReason;
  if (
    (error.code === 'store_admission_failed' && !validAdmissionReason(admissionReason)) ||
    (error.code !== 'store_admission_failed' && admissionReason !== undefined)
  )
    return undefined;
  return {
    code: error.code as ServiceStartupDiagnostic['code'],
    actualSchema: schema(compatibility?.actualSchema),
    expectedSchema: schema(compatibility?.expectedSchema),
    ...(validPhase(error.stage) ? { stage: error.stage } : {}),
    ...(validAdmissionReason(admissionReason) ? { admissionReason } : {}),
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
    if (line.length > 320) return undefined;
    const value = decode(line.slice(SERVICE_STARTUP_DIAGNOSTIC_PREFIX.length));
    if (!isRecord(value)) return undefined;
    const keys = Object.keys(value).sort().join(',');
    const expectedKeys = [
      'actualSchema',
      'code',
      'expectedSchema',
      ...('stage' in value ? ['stage'] : []),
      ...('admissionReason' in value ? ['admissionReason'] : []),
    ]
      .sort()
      .join(',');
    if (keys !== expectedKeys) return undefined;
    if (
      typeof value.code !== 'string' ||
      !CODES.has(value.code) ||
      !validSchema(value.actualSchema) ||
      !validSchema(value.expectedSchema)
    )
      return undefined;
    if ('stage' in value && !validPhase(value.stage)) return undefined;
    if (
      (value.code === 'store_admission_failed' && !validAdmissionReason(value.admissionReason)) ||
      (value.code !== 'store_admission_failed' && 'admissionReason' in value)
    )
      return undefined;
    return value as ServiceStartupDiagnostic;
  }
  return undefined;
}

export function encodeServiceStartupProgress(phase: ServiceStartupPhase): string {
  if (!validPhase(phase)) throw new TypeError('Invalid Service startup phase.');
  return `${SERVICE_STARTUP_PROGRESS_PREFIX}${JSON.stringify({ phase })}\n`;
}

/** Parse one complete line, never an arbitrary message or partially received JSON. */
export function parseServiceStartupProgress(line: string): ServiceStartupProgress | undefined {
  line = line.replace(/\r?\n$/u, '');
  if (line.length > 128 || !line.startsWith(SERVICE_STARTUP_PROGRESS_PREFIX)) return undefined;
  const value = decode(line.slice(SERVICE_STARTUP_PROGRESS_PREFIX.length));
  if (!isRecord(value) || Object.keys(value).join(',') !== 'phase' || !validPhase(value.phase))
    return undefined;
  return { phase: value.phase };
}

export function describeServiceStartupProgress(progress: ServiceStartupProgress): string {
  switch (progress.phase) {
    case 'inspecting':
      return '正在检查已有会话数据…';
    case 'acquiring_maintenance':
      return '正在确认会话存储可以安全维护…';
    case 'waiting_for_store':
      return '会话存储正由现有客户端或其他整理进程使用，正在自动重试；可以请求退出，超时后请按提示重试。';
    case 'preparing':
      return '正在备份、整理并核对会话数据；请求退出后需等待安全取消或提交结算。';
    case 'publishing':
      return '正在提交并复核会话数据，请等待完成后退出；意外中断会在下次启动时接续。';
    case 'ready':
      return '会话数据已就绪，正在连接服务…';
  }
}

/** Export only public facts. Error messages, stderr, paths and database content are never copied. */
function serviceStartupDiagnosticRetryable(diagnostic: ServiceStartupDiagnostic): boolean {
  return diagnostic.code === 'store_busy' || diagnostic.code === 'store_preparation_cancelled';
}

export function formatServiceStartupReport(diagnostic: ServiceStartupDiagnostic): string {
  const checked = parseServiceStartupDiagnostic(
    SERVICE_STARTUP_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic),
  );
  if (!checked) throw new TypeError('Invalid Service startup diagnostic.');
  const action =
    checked.code === 'store_admission_failed'
      ? admissionAction(checked.admissionReason!)
      : checked.code === 'store_preparation_retry_blocked'
        ? 'use_updated_version_or_recovery'
        : checked.code === 'store_preparation_cancelled'
          ? 'retry_startup'
          : checked.code === 'store_access_denied'
            ? 'check_permissions'
            : checked.code === 'store_insufficient_space'
              ? 'free_space'
              : checked.code === 'store_corrupt'
                ? 'preserve_data_and_seek_recovery'
                : checked.code === 'store_busy'
                  ? 'close_other_clients'
                  : checked.code === 'store_history_reconciliation_required'
                    ? 'use_updated_version_or_recovery'
                    : 'use_compatible_version';
  return `${JSON.stringify(
    {
      schema: 'kite.startup-diagnostic.v1',
      code: checked.code,
      stage: checked.stage ?? null,
      ...(checked.admissionReason ? { admissionReason: checked.admissionReason } : {}),
      actualSchema: checked.actualSchema,
      expectedSchema: checked.expectedSchema,
      retryable: serviceStartupDiagnosticRetryable(checked),
      actions:
        checked.code === 'store_admission_failed' ||
        checked.code === 'store_preparation_retry_blocked' ||
        checked.code === 'store_history_reconciliation_required'
          ? [action, 'save_diagnostic']
          : [action, 'retry_after_resolving_condition', 'save_diagnostic'],
    },
    null,
    2,
  )}\n`;
}

export function describeServiceStartupFailure(
  diagnostic: ServiceStartupDiagnostic | undefined,
  exitCode: number | null,
): string {
  if (diagnostic) {
    const code = diagnostic.code.toUpperCase();
    if (diagnostic.code === 'store_admission_failed')
      return `${code}：${validAdmissionReason(diagnostic.admissionReason) ? describeAdmissionReason(diagnostic.admissionReason) : '无法完成会话数据维护准入核实。请保存诊断以便排查。'}会话数据及恢复资料保持不变。`;
    if (diagnostic.code === 'store_preparation_retry_blocked')
      return `${code}：同一版本对未变化的会话数据已尝试整理且未完成；为避免重复占用磁盘，本版本不会再次复制。请使用修复版本或保存诊断进行恢复处理；原数据及恢复资料保持不变。`;
    if (diagnostic.code === 'store_preparation_cancelled')
      return `${code}：已在提交前取消会话数据整理，原会话数据保持不变，可以重新启动。`;
    if (diagnostic.code === 'store_access_denied')
      return `${code}：无法访问会话数据。请检查数据目录的所有者、访问权限及磁盘可用状态后重新尝试；不要删除数据库。`;
    if (diagnostic.code === 'store_corrupt')
      return `${code}：会话数据库未通过完整性检查。请保留当前数据库及恢复资料，保存诊断后通过恢复流程处理；不会自动清空或覆盖数据。`;
    if (diagnostic.code === 'store_history_reconciliation_required')
      return `${code}：会话数据自动整理未通过校验，原数据及恢复资料已保留。请保存诊断并使用修复版本继续整理；同一版本对未变化的数据不会重复建立备份。`;
    if (diagnostic.code === 'store_insufficient_space')
      return `${code}：磁盘可用空间不足，暂时无法完成会话数据整理。请释放磁盘空间后重新尝试；不要删除 Kite 会话数据或恢复资料。`;
    if (diagnostic.code === 'store_busy')
      return `${code}：会话存储正忙，请关闭其他正在使用该数据的 Kite 客户端后重试。`;
    const actual = diagnostic.actualSchema === null ? '未知' : String(diagnostic.actualSchema);
    const expected =
      diagnostic.expectedSchema === null ? '未知' : String(diagnostic.expectedSchema);
    return `${code}：当前版本无法处理这份会话数据（数据格式 ${actual}，程序支持 ${expected}）。数据保持原样，请使用创建这份数据的版本或支持该格式的新版本后重新尝试。`;
  }
  return `配套服务启动失败（退出码 ${exitCode ?? '未知'}）。`;
}
function decode(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validPhase(value: unknown): value is ServiceStartupPhase {
  return typeof value === 'string' && (SERVICE_STARTUP_PHASES as readonly string[]).includes(value);
}
function validSchema(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function schema(value: unknown): number | null {
  return validSchema(value) ? value : null;
}
function validAdmissionReason(value: unknown): value is ServiceStoreAdmissionReason {
  return (
    typeof value === 'string' &&
    (SERVICE_STORE_ADMISSION_REASONS as readonly string[]).includes(value)
  );
}
function admissionAction(reason: ServiceStoreAdmissionReason): string {
  switch (reason) {
    case 'unsupported_platform':
      return 'use_supported_platform';
    case 'desktop_identity_mismatch':
    case 'paired_manifest_mismatch':
    case 'source_identity_mismatch':
    case 'source_build_mismatch':
    case 'installed_identity_mismatch':
    case 'release_selection_busy_or_unsafe':
      return 'verify_matching_installation';
    case 'desktop_parent_unverified':
    case 'source_parent_unverified':
    case 'installed_parent_unverified':
      return 'restart_verified_client';
    case 'legacy_process_inspection_incomplete':
    case 'installed_process_inspection_incomplete':
      return 'inspect_other_clients';
    case 'admission_unverified':
      return 'save_diagnostic_for_recovery';
  }
}
function describeAdmissionReason(reason: ServiceStoreAdmissionReason): string {
  switch (reason) {
    case 'unsupported_platform':
      return '此平台不支持自动整理会话数据。请使用支持的运行环境。';
    case 'desktop_identity_mismatch':
    case 'paired_manifest_mismatch':
    case 'source_identity_mismatch':
    case 'source_build_mismatch':
    case 'installed_identity_mismatch':
    case 'release_selection_busy_or_unsafe':
      return '无法核实客户端与配套服务或安装版本。请检查安装并从受支持的入口重新启动。';
    case 'desktop_parent_unverified':
    case 'source_parent_unverified':
    case 'installed_parent_unverified':
      return '无法核实启动配套服务的客户端。请退出 Kite 后从受支持的入口重新启动。';
    case 'legacy_process_inspection_incomplete':
    case 'installed_process_inspection_incomplete':
      return '无法完整核实其他客户端是否仍在使用会话数据。请退出其他 Kite 客户端并保存诊断。';
    case 'admission_unverified':
      return '无法完成会话数据维护准入核实。请保存诊断以便排查。';
  }
}
