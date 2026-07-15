export type McpDiagnosticCode =
  | 'auth_required'
  | 'url_invalid'
  | 'command_not_found'
  | 'process_exited'
  | 'connect_timeout'
  | 'discovery_timeout'
  | 'http_4xx'
  | 'http_5xx'
  | 'discovery_failed'
  | 'invalid_schema'
  | 'approval_required'
  | 'approval_rejected'
  | 'circuit_open'
  | 'config_conflict'
  | 'config_invalid'
  | 'unknown';

export interface McpDiagnostic {
  code: McpDiagnosticCode;
  retryable: boolean;
  message: string;
  technical?: Readonly<{
    status?: number;
    errno?: string;
    phase?: 'connect' | 'discovery' | 'call';
  }>;
}

export type McpDiagnosticPhase = 'connect' | 'discovery' | 'call';

/** Convert SDK/Node failures into a redacted, frontend-neutral diagnostic. */
export function diagnoseMcpError(
  error: unknown,
  options: { phase?: McpDiagnosticPhase; fallbackCode?: McpDiagnosticCode } = {},
): McpDiagnostic {
  const record = asRecord(error);
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactDiagnosticMessage(rawMessage);
  const status = numericStatus(record);
  const errno = typeof record.code === 'string' ? record.code : undefined;
  const phase = options.phase;
  const lower = rawMessage.toLowerCase();

  if (status === 401 || status === 403 || /unauthori[sz]ed|authentication required/.test(lower)) {
    return diagnostic('auth_required', false, message, { status, errno, phase });
  }
  if (errno === 'ENOENT') {
    return diagnostic('command_not_found', false, message, { errno, phase });
  }
  if (
    errno === 'ERR_INVALID_URL' ||
    /invalid url|failed to parse url|cannot be parsed as a url/.test(lower)
  ) {
    return diagnostic('url_invalid', false, message, { errno, phase });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return diagnostic('http_4xx', status === 408 || status === 429, message, {
      status,
      errno,
      phase,
    });
  }
  if (status !== undefined && status >= 500) {
    return diagnostic('http_5xx', true, message, { status, errno, phase });
  }
  if (errno === 'ETIMEDOUT' || /timeout|timed out/.test(lower)) {
    return diagnostic(
      phase === 'discovery' ? 'discovery_timeout' : 'connect_timeout',
      true,
      message,
      {
        errno,
        phase,
      },
    );
  }
  if (/exited|exit code|closed before/.test(lower)) {
    return diagnostic('process_exited', true, message, { errno, phase });
  }
  return diagnostic(
    options.fallbackCode ?? (phase === 'discovery' ? 'discovery_failed' : 'unknown'),
    options.fallbackCode !== 'invalid_schema',
    message,
    { status, errno, phase },
  );
}

export function redactDiagnosticMessage(message: string): string {
  const bounded = message.slice(0, 2048);
  return bounded
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/([?&](?:token|key|secret|password|code)=)[^\s&#]*/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s/]+(?:\/[^\s]*)?/gi, (value) => {
      try {
        const url = new URL(value);
        return url.origin;
      } catch {
        return '[REDACTED_URL]';
      }
    });
}

function diagnostic(
  code: McpDiagnosticCode,
  retryable: boolean,
  message: string,
  technical: { status?: number; errno?: string; phase?: McpDiagnosticPhase },
): McpDiagnostic {
  const compact = Object.fromEntries(
    Object.entries(technical).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );
  return Object.freeze({
    code,
    retryable,
    message,
    ...(Object.keys(compact).length > 0 ? { technical: Object.freeze(compact) } : {}),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function numericStatus(record: Record<string, unknown>): number | undefined {
  const value = record.status ?? record.statusCode;
  return typeof value === 'number' ? value : undefined;
}
