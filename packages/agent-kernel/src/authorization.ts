/**
 * Pure authorization-elevation facts and invariants owned by Agent Kernel.
 *
 * This module deliberately accepts only canonical facts supplied by the
 * caller. It has no clock, randomness, persistence, provider, Host, Builtin,
 * or App dependency.
 */

import { sha256Hex } from './hash';
import type { AgentAuthorizationState } from './state';

export type AuthorizationSource = 'user' | 'config' | 'test' | 'system';

export interface AuthorizationElevationFacts {
  readonly mode: 'default' | 'full_access';
  readonly source?: AuthorizationSource;
  readonly sandboxAvailable: boolean;
  readonly autoReview?: boolean;
  readonly loopMode?: boolean;
}

export type ApprovalGrant = 'approve_once' | 'same_command' | 'full_access';

function stableAuthorizationJson(value: Readonly<Record<string, string>>): string {
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`)
    .join(',')}}`;
}

export function authorizationCommandGrantKey(input: {
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
}): string {
  return sha256Hex(
    `same_command:${stableAuthorizationJson({
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.command.trim(),
    })}`,
  );
}

/** Apply one canonical approval grant using only Host-supplied time and facts. */
export function applyApprovalGrant(input: {
  readonly authorization: Readonly<AgentAuthorizationState>;
  readonly grant: ApprovalGrant;
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
  readonly source: AuthorizationSource;
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
  const key = authorizationCommandGrantKey({ ...input, command });
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
export function assertAuthorizationElevation(input: AuthorizationElevationFacts): void {
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
