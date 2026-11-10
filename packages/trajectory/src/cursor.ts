import { z } from 'zod';

export const MAXIMUM_DECIMAL64 = '9223372036854775807';
// JSON Schema and runtime validation use precisely the same signed SQLite range.
const maximumAlternatives = [...MAXIMUM_DECIMAL64].flatMap((digit, index) => {
  const lower = index === 0 ? 1 : 0;
  const upper = Number(digit) - 1;
  if (upper < lower) return [];
  const choice = lower === upper ? `${lower}` : `[${lower}-${upper}]`;
  const remaining = MAXIMUM_DECIMAL64.length - index - 1;
  return [`${MAXIMUM_DECIMAL64.slice(0, index)}${choice}${remaining ? `[0-9]{${remaining}}` : ''}`];
});
export const DECIMAL64_PATTERN = `^(?:0|[1-9][0-9]{0,17}|${maximumAlternatives.join('|')}|${MAXIMUM_DECIMAL64})$`;
export const decimal64Schema = z.string().regex(new RegExp(DECIMAL64_PATTERN));
export type Decimal64 = z.infer<typeof decimal64Schema>;
export function parseDecimal64(value: unknown): bigint {
  return BigInt(decimal64Schema.parse(value));
}
export function compareDecimal64(left: Decimal64, right: Decimal64): -1 | 0 | 1 {
  const a = parseDecimal64(left);
  const b = parseDecimal64(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
