const FOLLOWUP_PROXY_PARENT_TOOL_PREFIX = 'followup-approval:v2:';

export interface FollowupChildApprovalParentToolIdentity {
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly sourceToolCallId: string;
}

/** Canonical identity shared by the Store and the Service approval route. */
export function followupChildApprovalParentToolCallId(
  input: FollowupChildApprovalParentToolIdentity,
): string {
  const parts = [input.submissionId, input.targetRunId, input.sourceToolCallId];
  if (parts.some((part) => !part || part.length > 4096))
    throw new Error('Followup approval source identity is invalid.');
  return `${FOLLOWUP_PROXY_PARENT_TOOL_PREFIX}${Buffer.from(JSON.stringify(parts)).toString('base64url')}`;
}

export function parseFollowupChildApprovalParentToolCallId(
  value: string,
): FollowupChildApprovalParentToolIdentity | null {
  if (!value.startsWith(FOLLOWUP_PROXY_PARENT_TOOL_PREFIX)) return null;
  try {
    const parts = JSON.parse(
      Buffer.from(value.slice(FOLLOWUP_PROXY_PARENT_TOOL_PREFIX.length), 'base64url').toString(
        'utf8',
      ),
    ) as unknown;
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      parts.some((part) => typeof part !== 'string' || !part || part.length > 4096)
    )
      return null;
    const identity = {
      submissionId: parts[0] as string,
      targetRunId: parts[1] as string,
      sourceToolCallId: parts[2] as string,
    };
    return followupChildApprovalParentToolCallId(identity) === value ? identity : null;
  } catch {
    return null;
  }
}
