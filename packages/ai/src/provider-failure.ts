import type { ModelRequest } from './index';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failureRecord(envelope: Record<string, unknown> | undefined) {
  return record(envelope?.error) ?? record(record(envelope?.response)?.error) ?? envelope;
}

export function providerDeclaredContextOverflow(reported: unknown): boolean {
  const envelope = record(reported);
  return (
    failureRecord(envelope)?.code === 'context_length_exceeded' ||
    envelope?.code === 'context_length_exceeded'
  );
}

const unsafeText =
  /[\p{Cc}\p{Cf}]|https?:\/\/|<[a-z!?][^>]*>|\b(?:bearer\s+\S|(?:api[ _-]?key|authorization|cookie|password|secret|access[ _-]?token|refresh[ _-]?token)\s*["']?\s*[:=]|sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)|-----BEGIN |"(?:messages|input|headers|request)"\s*:/iu;

/** Read a short display diagnostic from a provider error, independently of retry classification. */
export function providerFailureMessage(
  reported: unknown,
  credentials: readonly string[],
  request: ModelRequest,
  http?: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  },
): string | undefined {
  const type = http?.headers?.['content-type']?.toLowerCase();
  const body = http?.body;
  let envelope = record(reported);
  if (!envelope && typeof body === 'string' && body.length <= 8192) {
    try {
      envelope = record(JSON.parse(body));
    } catch {
      // Plain-text responses require the provider to identify that media type.
    }
  }
  const error = failureRecord(envelope);
  const safe = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return undefined;
    const text = value.trim().split(/\r?\n/, 1)[0]?.trim();
    if (!text || unsafeText.test(text) || credentials.some((secret) => text.includes(secret)))
      return undefined;
    for (const message of request.messages) {
      if (message.content.length >= 12 && text.includes(message.content)) return undefined;
      if (
        message.toolCalls?.some(
          ({ arguments: input }) => input.length >= 12 && text.includes(input),
        )
      )
        return undefined;
    }
    return text;
  };
  const rawCode = error?.code;
  const code =
    typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? String(rawCode) : rawCode;
  const safeCode =
    typeof code === 'string' && /^[a-z\d_.-]{1,64}$/i.test(code) ? safe(code) : undefined;
  const reportedMessage = safe(
    error?.message ??
      error?.detail ??
      (typeof envelope?.error === 'string' ? envelope.error : undefined) ??
      (type?.startsWith('text/plain') ? body : undefined),
  );
  // Bare machine tokens are useful only when the provider actually labels them as a code.
  const message =
    reportedMessage && !/^[a-z\d_.-]+$/i.test(reportedMessage) ? reportedMessage : undefined;
  // Some SDK stream errors have a synthetic status code. Only use the HTTP
  // status when the error carries actual non-stream response headers.
  const status = http?.status;
  const httpLabel =
    type &&
    !type.includes('text/event-stream') &&
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
      ? `HTTP ${status}`
      : undefined;
  const text = [httpLabel, safeCode, message].filter(Boolean).join(' · ');
  if (!text) return undefined;
  return text.length <= 512 ? text : `${text.slice(0, 511).replace(/[\uD800-\uDBFF]$/u, '')}…`;
}
