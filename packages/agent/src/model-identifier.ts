import { AgentError } from './storage/types';

/** Lossless spelling only, never a lookup by prefix or a replacement identity. */
export function modelIdentifier(value: string): string {
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
    return `u${Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url')}`;
  if (/^mcp-[a-f0-9]{64}$/.test(value))
    return `h${Buffer.from(value.slice(4), 'hex').toString('base64url')}`;
  return `s${Buffer.from(value, 'utf8').toString('base64url')}`;
}
export function readModelIdentifier(value: string): string {
  if (value.length > 1024) throw new AgentError('tool_reference_invalid');
  const bytes = Buffer.from(value.slice(1), 'base64url');
  const hex = bytes.toString('hex');
  const decoded =
    value[0] === 'u' && bytes.length === 16
      ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      : value[0] === 'h' && bytes.length === 32
        ? `mcp-${hex}`
        : value[0] === 's'
          ? bytes.toString('utf8')
          : '';
  if (
    !decoded ||
    decoded.length > 256 ||
    decoded.includes('\0') ||
    modelIdentifier(decoded) !== value
  )
    throw new AgentError('tool_reference_invalid');
  return decoded;
}
export const modelExecutionId = (id: string) => `e.${modelIdentifier(id)}`;
/** Raw execution IDs remain ordinary exact identities; encoded IDs decode losslessly. */
export const readModelExecutionId = (id: string) =>
  id.startsWith('e.') ? readModelIdentifier(id.slice(2)) : id;
