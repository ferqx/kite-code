import { hashToolApprovalRequest } from '@/core/harness/tool-policy';
import type { PendingToolRequest } from '@/core/harness/tool-requests';
import type { ShellGrantUsed } from '@/protocol/events';

export interface PermitEntry {
  grant: ShellGrantUsed;
  argsHash: string;
  consumed: boolean;
}

export type PermitBatch = Record<string, PermitEntry>;

export function isPermitEntry(value: unknown): value is PermitEntry {
  return (
    !!value &&
    typeof value === 'object' &&
    'grant' in value &&
    'argsHash' in value &&
    'consumed' in value
  );
}

export function migratePermitBatch(raw: unknown): PermitBatch {
  if (!raw || typeof raw !== 'object') return {};
  const migrated: PermitBatch = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isPermitEntry(value)) migrated[id] = value;
  }
  return migrated;
}

export function issuePermit(input: {
  batch: PermitBatch;
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  grant: ShellGrantUsed;
}): PermitBatch {
  if (!input.request.id) return input.batch;
  return {
    ...input.batch,
    [input.request.id]: {
      grant: input.grant,
      argsHash: hashToolApprovalRequest({
        workspace: input.workspace,
        threadId: input.threadId,
        request: input.request,
      }),
      consumed: false,
    },
  };
}

export function claimPermit(input: {
  batch: PermitBatch;
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
}): { ok: true; grant: ShellGrantUsed } | { ok: false; reason: string } {
  const id = input.request.id;
  if (!id) return { ok: false, reason: 'No valid permit for this tool call.' };
  const permit = input.batch[id];
  if (!permit || permit.consumed) {
    return { ok: false, reason: 'No valid permit for this tool call.' };
  }
  const actualHash = hashToolApprovalRequest({
    workspace: input.workspace,
    threadId: input.threadId,
    request: input.request,
  });
  if (permit.argsHash !== actualHash) {
    return { ok: false, reason: 'Tool arguments changed after approval.' };
  }
  permit.consumed = true;
  return { ok: true, grant: permit.grant };
}
