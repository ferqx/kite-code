import { createHash } from 'node:crypto';
import type { Json } from '../../storage/types';

/** Private naming intent. Legacy automatic-title records retain their original interpretation. */
export const automaticTitleRecord = {
  extensionId: 'builtin.session-title',
  key: 'automatic-title-attempt',
  contentType: 'automatic-session-title-attempt',
  contentVersion: 1,
} as const;

export interface AutomaticTitleAttempt {
  sourceCommandId: string;
  fallbackDigest: string;
  manualRenameCommandId: string | null;
  jobExecutionId: string | null;
  sourceRunId: string | null;
  modelExecutionId: string | null;
  publication: 'pending' | 'published' | 'closed';
  publicationCommandId: string | null;
  closedReason: string | null;
}

export function automaticTitleIdentity(storeId: string, sessionId: string, commandId: string) {
  const key = createHash('sha256')
    .update(JSON.stringify([storeId, sessionId, commandId]))
    .digest('hex');
  return {
    fallbackCommandId: `auto-title-fallback-${key}`,
    publicationCommandId: `auto-title-published-${key}`,
    operationKey: `generate/${key}`,
  };
}

export function titleDigest(title: string): string {
  return createHash('sha256').update(title).digest('hex');
}

export function readAutomaticTitleAttempt(value: Json): AutomaticTitleAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = [
    'sourceCommandId',
    'fallbackDigest',
    'manualRenameCommandId',
    'jobExecutionId',
    'sourceRunId',
    'modelExecutionId',
    'publication',
    'publicationCommandId',
    'closedReason',
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    typeof value.sourceCommandId !== 'string' ||
    !value.sourceCommandId ||
    typeof value.fallbackDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.fallbackDigest) ||
    !['pending', 'published', 'closed'].includes(String(value.publication)) ||
    keys
      .slice(2)
      .filter((key) => key !== 'publication')
      .some((key) => value[key] !== null && (typeof value[key] !== 'string' || !value[key]))
  )
    return null;
  if (
    value.publication === 'pending' &&
    (value.publicationCommandId !== null || value.closedReason !== null)
  )
    return null;
  if (
    value.publication === 'published' &&
    (typeof value.publicationCommandId !== 'string' ||
      value.closedReason !== null ||
      value.jobExecutionId === null ||
      value.sourceRunId === null ||
      value.modelExecutionId === null)
  )
    return null;
  if (
    (value.jobExecutionId === null &&
      (value.sourceRunId !== null || value.modelExecutionId !== null)) ||
    (value.sourceRunId === null && value.modelExecutionId !== null)
  )
    return null;
  if (
    value.publication === 'closed' &&
    (value.publicationCommandId !== null || typeof value.closedReason !== 'string')
  )
    return null;
  return value as unknown as AutomaticTitleAttempt;
}
