import type { z } from 'zod';
import {
  assertAgentApiJsonValue,
  assertNoUnknownAgentApiJsonFields,
  assertSameAgentApiJsonShape,
} from './limits';

export interface AgentApiRequestCodec<Schema extends z.ZodType> {
  readonly schema: Schema;
  decode(input: unknown): z.output<Schema>;
  safeDecode(
    input: unknown,
  ):
    | { readonly success: true; readonly data: z.output<Schema> }
    | { readonly success: false; readonly error: unknown };
}

export interface AgentApiResponseCodec<Schema extends z.ZodType> {
  readonly schema: Schema;
  /** Client-side decoder: unknown optional response fields are ignored. */
  decode(input: unknown): z.output<Schema>;
  /** Server-side encoder: undeclared fields fail instead of being stripped. */
  encode(input: z.input<Schema>): z.output<Schema>;
}

export function requestCodec<Schema extends z.ZodType>(
  schema: Schema,
): AgentApiRequestCodec<Schema> {
  return Object.freeze({
    schema,
    decode(input: unknown): z.output<Schema> {
      return decodeAgentApiRequest(schema, input);
    },
    safeDecode(input: unknown) {
      try {
        return { success: true as const, data: decodeAgentApiRequest(schema, input) };
      } catch (error) {
        return { success: false as const, error };
      }
    },
  });
}

export function responseCodec<Schema extends z.ZodType>(
  schema: Schema,
): AgentApiResponseCodec<Schema> {
  return Object.freeze({
    schema,
    decode(input: unknown): z.output<Schema> {
      return decodeAgentApiResponse(schema, input);
    },
    encode(input: z.input<Schema>): z.output<Schema> {
      return encodeAgentApiResponse(schema, input);
    },
  });
}

export function decodeAgentApiRequest<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  assertAgentApiJsonValue(input);
  const parsed = schema.parse(input);
  assertNoUnknownAgentApiJsonFields(input, parsed, 'request');
  return parsed;
}

export function decodeAgentApiResponse<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  assertAgentApiJsonValue(input);
  return schema.parse(input);
}

export function encodeAgentApiResponse<Schema extends z.ZodType>(
  schema: Schema,
  input: z.input<Schema>,
): z.output<Schema> {
  assertAgentApiJsonValue(input);
  const parsed = schema.parse(input);
  assertSameAgentApiJsonShape(input, parsed, 'response');
  return parsed;
}
