import { z } from 'zod';
import {
  AGENT_API_LIMITS,
  assertAgentApiJsonValue,
  assertUtf8ByteLength,
  utf8ByteLength,
} from './limits';

const hasOnlyAllowedControls = (value: string): boolean =>
  ![...value].some(
    (character) =>
      /\p{Cc}/u.test(character) && character !== '\n' && character !== '\r' && character !== '\t',
  );

export function boundedText(
  maximumBytes: number,
  options: { readonly minimumBytes?: number; readonly multiline?: boolean } = {},
) {
  const minimumBytes = options.minimumBytes ?? 0;
  return z.string().superRefine((value, context) => {
    const length = utf8ByteLength(value);
    if (length < minimumBytes || length > maximumBytes) {
      context.addIssue({
        code: 'custom',
        message: `text must contain ${minimumBytes}-${maximumBytes} UTF-8 bytes`,
      });
    }
    if (!hasOnlyAllowedControls(value)) {
      context.addIssue({ code: 'custom', message: 'text contains a forbidden control character' });
    }
    if (options.multiline === false && /[\r\n]/u.test(value)) {
      context.addIssue({ code: 'custom', message: 'text must be single-line' });
    }
  });
}

export const agentApiIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .superRefine((value, context) => {
    if (utf8ByteLength(value) > AGENT_API_LIMITS.maxIdentifierBytes) {
      context.addIssue({ code: 'custom', message: 'identity exceeds its UTF-8 byte limit' });
    }
  });

export const agentApiOpaqueTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/u)
  .superRefine((value, context) => {
    const length = utf8ByteLength(value);
    if (length < 1 || length > AGENT_API_LIMITS.maxCursorBytes) {
      context.addIssue({ code: 'custom', message: 'opaque token exceeds its byte limit' });
    }
  });

export const agentApiAccessTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const agentApiEtagSchema = z
  .string()
  .regex(/^"session:[A-Za-z0-9][A-Za-z0-9._:-]*:rev:(?:0|[1-9][0-9]*)"$/u)
  .superRefine((value, context) => {
    if (utf8ByteLength(value) > 256) {
      context.addIssue({ code: 'custom', message: 'ETag exceeds its byte limit' });
    }
  });

export const agentApiIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/u);

export const agentApiRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const agentApiPositiveRevisionSchema = agentApiRevisionSchema.min(1);
export const agentApiPageLimitSchema = z.number().int().min(1).max(AGENT_API_LIMITS.maxPageLimit);
export const agentApiWaitMillisecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(AGENT_API_LIMITS.maxWaitMilliseconds);

export const agentApiTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }, 'timestamp must be an exact UTC RFC 3339 millisecond value');

export const agentApiShortTextSchema = boundedText(AGENT_API_LIMITS.maxShortTextBytes, {
  multiline: false,
});
export const agentApiDetailTextSchema = boundedText(AGENT_API_LIMITS.maxDetailBytes);
export const agentApiRunInputSchema = boundedText(AGENT_API_LIMITS.maxRunInputBytes, {
  minimumBytes: 1,
});

export const agentApiJsonValueSchema = z.unknown().superRefine((value, context) => {
  try {
    assertAgentApiJsonValue(value, { maxBytes: AGENT_API_LIMITS.maxSkillInputBytes });
  } catch (error) {
    context.addIssue({ code: 'custom', message: (error as Error).message });
  }
});

export const agentApiJsonObjectSchema = agentApiJsonValueSchema.pipe(
  z.record(z.string(), z.unknown()),
);

export function uniqueLexicalValues<Value extends string>(
  values: readonly Value[],
  context: z.RefinementCtx,
): void {
  const sorted = [...new Set(values)].sort();
  if (sorted.length !== values.length || sorted.some((value, index) => value !== values[index])) {
    context.addIssue({ code: 'custom', message: 'values must be unique and lexically sorted' });
  }
}

export function assertScalarUtf8Bytes(value: string, maximum: number, label: string): string {
  assertUtf8ByteLength(value, maximum, label);
  return value;
}
