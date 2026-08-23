/**
 * Pure authorization-elevation facts and invariants owned by Agent Kernel.
 *
 * This module deliberately accepts only canonical facts supplied by the
 * caller. It has no clock, randomness, persistence, provider, Host, Builtin,
 * or App dependency.
 */

import { sha256Hex } from './hash';
import type { AgentAuthorizationState } from './state';

export type AuthorizationSourceV1 = 'user' | 'config' | 'test' | 'system';

export interface AuthorizationElevationFactsV1 {
  readonly mode: 'default' | 'full_access';
  readonly source?: AuthorizationSourceV1;
  readonly sandboxAvailable: boolean;
  readonly autoReview?: boolean;
  readonly loopMode?: boolean;
}

export type ApprovalGrantV1 = 'approve_once' | 'same_command' | 'full_access';

function stableAuthorizationJsonV1(value: Readonly<Record<string, string>>): string {
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`)
    .join(',')}}`;
}

export function authorizationCommandGrantKeyV1(input: {
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
}): string {
  return sha256Hex(
    `same_command:${stableAuthorizationJsonV1({
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.command.trim(),
    })}`,
  );
}

/** Apply one canonical approval grant using only Host-supplied time and facts. */
export function applyApprovalGrantV1(input: {
  readonly authorization: Readonly<AgentAuthorizationState>;
  readonly grant: ApprovalGrantV1;
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
  readonly source: AuthorizationSourceV1;
  readonly grantedAt: string;
}): AgentAuthorizationState {
  if (input.grant === 'full_access') {
    return {
      ...input.authorization,
      mode: 'full_access',
      modeSource: input.source,
      modeGrantedAt: input.grantedAt,
    };
  }
  const command = input.command.trim();
  if (input.grant !== 'same_command' || command.length === 0) return input.authorization;
  const key = authorizationCommandGrantKeyV1({ ...input, command });
  return {
    ...input.authorization,
    commandGrants: {
      ...input.authorization.commandGrants,
      [key]: {
        workspace: input.workspace,
        threadId: input.threadId,
        command,
        source: input.source,
        grantedAt: input.grantedAt,
      },
    },
  };
}

/** Enforce every State authorization elevation invariant. */
export function assertAuthorizationElevation(input: AuthorizationElevationFactsV1): void {
  if (input.mode === 'full_access' && !input.sandboxAvailable) {
    throw new Error('full_access requires an available workspace sandbox.');
  }
  if (input.autoReview && input.source === 'system' && input.mode === 'full_access') {
    throw new Error('auto-review cannot grant full_access.');
  }
  if (input.loopMode && input.mode === 'full_access' && input.source === 'system') {
    throw new Error('loop-mode cannot auto-elevate authorization.');
  }
}
