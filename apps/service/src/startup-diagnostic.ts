/** Retained bounded startup report protocol, projected from the current Service only. */
export const SERVICE_STARTUP_DIAGNOSTIC_PREFIX = 'KITE_SERVICE_STARTUP_ERROR_V1:';
export type ServiceStartupDiagnostic = Readonly<{
  code: 'data_unavailable';
  stage: 'opening_store';
}>;

/** Reject unknown fields rather than copying private stderr into the host or report. */
export function parseServiceStartupDiagnostic(
  stderr: string,
): ServiceStartupDiagnostic | undefined {
  for (const line of stderr.split('\n')) {
    if (!line.startsWith(SERVICE_STARTUP_DIAGNOSTIC_PREFIX)) continue;
    const json = line.slice(SERVICE_STARTUP_DIAGNOSTIC_PREFIX.length);
    if (json.length > 320) return undefined;
    try {
      const value: unknown = JSON.parse(json);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, 'code') ||
        !Object.hasOwn(value, 'stage') ||
        Reflect.get(value, 'code') !== 'data_unavailable' ||
        Reflect.get(value, 'stage') !== 'opening_store'
      )
        return undefined;
      return Object.freeze({ code: 'data_unavailable', stage: 'opening_store' });
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function encodeServiceStartupDiagnostic(diagnostic: ServiceStartupDiagnostic): string {
  const checked = parseServiceStartupDiagnostic(
    `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`,
  );
  if (!checked) throw Error('invalid_startup_diagnostic');
  return `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify(checked)}\n`;
}

/** Original report shape and fixed hints; this baseline performs no old-data migration. */
export function formatServiceStartupReport(diagnostic: ServiceStartupDiagnostic): string {
  const checked = parseServiceStartupDiagnostic(
    `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`,
  );
  if (!checked) throw Error('invalid_startup_diagnostic');
  return `${JSON.stringify(
    {
      schema: 'kite.startup-diagnostic.v1',
      code: checked.code,
      stage: checked.stage,
      actualSchema: null,
      expectedSchema: null,
      retryable: true,
      actions: [
        'verify_profile_storage_access',
        'retry_after_resolving_condition',
        'save_diagnostic',
      ],
    },
    null,
    2,
  )}\n`;
}
