import { semanticDigest } from './json';
import type { ToolCall } from './storage/types';

const MAX_EDITS = 32;
export type FileEditBatchInput = Readonly<{
  path: string;
  find: string;
  replace: string;
  replaceAll?: boolean;
}>;
export interface ResolvedEditTarget {
  /** The current root, verified parent and exact native file slot, not a lexical path alias. */
  readonly slot: string;
  /** The full baseline selected from this Model request for this exact slot. */
  readonly baseline: string;
  readonly counts?: {
    readonly added: number;
    readonly removed: number;
    readonly members?: readonly ({ readonly added: number; readonly removed: number } | null)[];
  };
}
type EditMember = Readonly<{ id: string; ordinal: number; input: FileEditBatchInput }>;

function editInput(call: ToolCall): FileEditBatchInput | undefined {
  if (call.name !== 'files.edit' || call.model?.error) return;
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['path', 'find', 'replace', 'replaceAll'].includes(key)) ||
    typeof input.path !== 'string' ||
    !input.path ||
    typeof input.find !== 'string' ||
    !input.find ||
    typeof input.replace !== 'string' ||
    (input.replaceAll !== undefined && typeof input.replaceAll !== 'boolean')
  )
    return;
  return Object.freeze({
    path: input.path,
    find: input.find,
    replace: input.replace,
    ...(input.replaceAll === undefined ? {} : { replaceAll: input.replaceAll }),
  });
}

/** Select immutable candidates from one sealed response, before individual admission.
 * This plans no execution and grants no permission. The trusted owner supplies exact
 * registered-definition, target and full-baseline proofs and must recheck at dispatch.
 */
export async function fileEditBatchPlans(
  modelExecutionId: string,
  calls: readonly ToolCall[],
  resolve: (call: ToolCall, input: FileEditBatchInput) => Promise<ResolvedEditTarget | null>,
) {
  if (!modelExecutionId || new Set(calls.map(({ id }) => id)).size !== calls.length) return [];
  const bySlot = new Map<
    string,
    { baseline: string; consistent: boolean; members: EditMember[] }
  >();
  for (const [ordinal, call] of calls.entries()) {
    const input = editInput(call);
    if (!input || !call.id) continue;
    const target = await resolve(call, input);
    if (!target?.slot || !target.baseline) continue;
    const batch = bySlot.get(target.slot);
    const member = Object.freeze({ id: call.id, ordinal, input });
    if (!batch) {
      bySlot.set(target.slot, { baseline: target.baseline, consistent: true, members: [member] });
    } else {
      batch.consistent &&= batch.baseline === target.baseline;
      // Retain one extra entry to distinguish an oversized group from a complete bounded one.
      if (batch.members.length <= MAX_EDITS) batch.members.push(member);
    }
  }
  return Promise.all(
    [...bySlot.entries()].flatMap(([slot, { baseline, consistent, members }]) => {
      if (!consistent || members.length < 2 || members.length > MAX_EDITS) return [];
      const sealed = {
        modelExecutionId,
        slot,
        baseline,
        members: members.map(({ id, input, ordinal }) => ({ id, input: { ...input }, ordinal })),
      };
      return [
        semanticDigest(sealed).then((digest) =>
          Object.freeze({
            modelExecutionId,
            slot,
            baseline,
            members: Object.freeze(members),
            interleaved: members.at(-1)!.ordinal - members[0]!.ordinal + 1 !== members.length,
            digest,
          }),
        ),
      ];
    }),
  );
}

/** Keep ordered admission intact; never move an edit across an unrelated call. */
export function consecutiveFileEditCandidates(calls: readonly ToolCall[]) {
  const byPath = new Map<string, { start: number; end: number; calls: ToolCall[] }>();
  for (const [index, call] of calls.entries()) {
    const path = editInput(call)?.path;
    if (!path) continue;
    const group = byPath.get(path);
    if (group) {
      group.end = index;
      group.calls.push(call);
    } else {
      byPath.set(path, { start: index, end: index, calls: [call] });
    }
  }
  return [...byPath.values()].flatMap(({ start, end, calls }) =>
    calls.length > 1 && calls.length <= MAX_EDITS && end - start + 1 === calls.length
      ? [Object.freeze(calls)]
      : [],
  );
}

export type FileEditBatchPlan = Awaited<ReturnType<typeof fileEditBatchPlans>>[number] & {
  readonly counts?: ResolvedEditTarget['counts'];
};

/** Wire display only. The mutation must still use the same private, reverified plan. */
export function fileEditBatchApproval(plan: FileEditBatchPlan) {
  return {
    kind: 'file_edit_batch@1',
    digest: plan.digest,
    ...(plan.counts ? { counts: { added: plan.counts.added, removed: plan.counts.removed } } : {}),
    members: plan.members.map(({ id, input }, index) => ({
      callId: id,
      path: input.path,
      find: input.find,
      replace: input.replace,
      replaceAll: input.replaceAll === true,
      ...(plan.counts?.members?.[index] ? { counts: plan.counts.members[index]! } : {}),
    })),
  } as const;
}
