import type { Json } from './storage/types';
import type { ToolBehaviorBinding } from './tool-behavior';

export type AuthorizationCheckAnswer = {
  decision: 'approve_once' | 'reject' | 'ask_user';
  reason: string;
};
/** Private owner receipt, sealed only after complete EOF, stop and zero ToolCalls. */
export type AuthorizationCheckOutput = {
  kind: 'authorization_check_output';
  version: 1;
  modelExecutionId: string;
  behavior: ToolBehaviorBinding;
  target: { executionId: string; attempt: number; inputDigest: string };
  checkInputDigest: string;
  sealedInputHash: string;
  modelOutputDigest: string;
  contentHash: string;
  materialFingerprint?: string;
  answer: AuthorizationCheckAnswer;
  evidence?: Json;
};
export const authorizationCheckOutputMediaType =
  'application/vnd.kite.authorization-check-output+json';
export const authorizationCheckOutputRefId = (digest: string) => `check-output-${digest}`;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
export function authorizationCheckAnswer(value: unknown): AuthorizationCheckAnswer | null {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'decision,reason' ||
    typeof value.decision !== 'string' ||
    !['approve_once', 'reject', 'ask_user'].includes(value.decision) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 8192
  )
    return null;
  return { decision: value.decision as AuthorizationCheckAnswer['decision'], reason: value.reason };
}
export function toolBehaviorBinding(value: unknown): ToolBehaviorBinding | null {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'capability,configurationDigest,contractRef' ||
    !text(value.contractRef) ||
    !digest(value.configurationDigest) ||
    !object(value.capability)
  )
    return null;
  const capability = value.capability;
  if (
    Object.keys(capability).sort().join(',') !== 'definitionId,definitionVersion,kind' ||
    !['tool', 'job', 'model'].includes(String(capability.kind)) ||
    !text(capability.definitionId) ||
    !text(capability.definitionVersion)
  )
    return null;
  return structuredClone(value) as unknown as ToolBehaviorBinding;
}
/** No domain parser or previous receipt format is installed in the Worker. */
export function authorizationCheckOutput(value: unknown): AuthorizationCheckOutput | null {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'kind',
          'version',
          'modelExecutionId',
          'behavior',
          'target',
          'checkInputDigest',
          'sealedInputHash',
          'modelOutputDigest',
          'contentHash',
          'materialFingerprint',
          'answer',
          'evidence',
        ].includes(key),
    ) ||
    value.kind !== 'authorization_check_output' ||
    value.version !== 1 ||
    !text(value.modelExecutionId) ||
    !toolBehaviorBinding(value.behavior) ||
    !object(value.target) ||
    Object.keys(value.target).sort().join(',') !== 'attempt,executionId,inputDigest' ||
    !text(value.target.executionId) ||
    !Number.isSafeInteger(value.target.attempt) ||
    Number(value.target.attempt) < 1 ||
    !digest(value.target.inputDigest) ||
    !digest(value.checkInputDigest) ||
    !digest(value.sealedInputHash) ||
    !digest(value.modelOutputDigest) ||
    !digest(value.contentHash) ||
    (value.materialFingerprint !== undefined && !digest(value.materialFingerprint)) ||
    !authorizationCheckAnswer(value.answer)
  )
    return null;
  return structuredClone(value) as unknown as AuthorizationCheckOutput;
}
