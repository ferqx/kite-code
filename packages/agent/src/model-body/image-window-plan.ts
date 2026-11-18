/** Pure delivery planning. Confirmations must be scoped/authenticated by the caller. */
export type ImageWindowMember = {
  executionId: string;
  ordinal: number;
  hash: string;
  size: number;
};
export interface WindowBatch {
  executionId: string;
  members: readonly ImageWindowMember[];
}
export class ImageWindowPlanError extends Error {
  readonly code: 'image_window_invalid_input' | 'image_window_member_too_large';
  readonly details: { executionId?: string; ordinal?: number; size?: number; budget?: number };
  constructor(
    code: ImageWindowPlanError['code'],
    details: { executionId?: string; ordinal?: number; size?: number; budget?: number } = {},
  ) {
    super(code);
    this.name = 'ImageWindowPlanError';
    this.code = code;
    this.details = details;
  }
}
const invalid = (): never => {
  throw new ImageWindowPlanError('image_window_invalid_input');
};
function validateMember(m: ImageWindowMember) {
  if (
    !m ||
    typeof m.executionId !== 'string' ||
    !m.executionId.trim() ||
    !Number.isSafeInteger(m.ordinal) ||
    m.ordinal < 1 ||
    typeof m.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(m.hash) ||
    !Number.isSafeInteger(m.size) ||
    m.size < 1
  )
    invalid();
}
/** Not an authority token: the caller also binds receipts to scope, route and selection. */
export function imageMemberKey(m: ImageWindowMember): string {
  validateMember(m);
  return JSON.stringify([m.executionId, m.ordinal, m.hash, m.size]);
}

/**
 * Only a wholly unconfirmed original batch may appear in a business tool result.
 * Observations are ordered read-only fragments; their union is not same-frame visibility.
 * No data is dropped, resized, mutated, or classified as delivered by this function.
 */
export function planImageWindow(
  batches: readonly WindowBatch[],
  confirmed: ReadonlySet<string>,
  budget: number,
  hardBudget = budget,
  // Explicit rich single-image rejections get one minimal standalone observation.
  standalone: ReadonlySet<string> = new Set(),
): { observe: ImageWindowMember[][]; business: ImageWindowMember[] } {
  if (
    !Array.isArray(batches) ||
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    !Number.isSafeInteger(hardBudget) ||
    hardBudget < budget ||
    !confirmed ||
    typeof confirmed.has !== 'function'
  )
    invalid();
  const executions = new Set<string>();
  const pending: { members: ImageWindowMember[]; whole: boolean; size: number }[] = [];
  for (const batch of batches) {
    if (
      !batch ||
      typeof batch.executionId !== 'string' ||
      !batch.executionId.trim() ||
      executions.has(batch.executionId) ||
      !Array.isArray(batch.members) ||
      !batch.members.length
    )
      invalid();
    executions.add(batch.executionId);
    let total = 0;
    const remaining: ImageWindowMember[] = [];
    for (const [index, member] of batch.members.entries()) {
      validateMember(member);
      if (member.executionId !== batch.executionId || member.ordinal !== index + 1) invalid();
      total += member.size;
      if (!Number.isSafeInteger(total)) invalid();
      if (!confirmed.has(imageMemberKey(member))) {
        remaining.push({ ...member });
      }
    }
    for (const member of remaining) {
      if (member.size > hardBudget)
        throw new ImageWindowPlanError('image_window_member_too_large', {
          executionId: member.executionId,
          ordinal: member.ordinal,
          size: member.size,
          budget: hardBudget,
        });
    }
    if (remaining.length)
      pending.push({
        members: remaining,
        whole:
          remaining.length === batch.members.length &&
          total <= budget &&
          remaining.length <= 128 &&
          !remaining.some((m) => standalone.has(imageMemberKey(m))),
        size: remaining.reduce((n, m) => n + m.size, 0),
      });
  }
  // Retain the maximal ordered suffix of complete batches fitting one business request.
  let suffix = pending.length,
    businessBytes = 0,
    businessCount = 0;
  while (suffix > 0) {
    const batch = pending[suffix - 1]!;
    if (
      !batch.whole ||
      batch.size > budget - businessBytes ||
      batch.members.length > 128 - businessCount
    )
      break;
    suffix--;
    businessBytes += batch.size;
    businessCount += batch.members.length;
  }
  const observe: ImageWindowMember[][] = [];
  let frame: ImageWindowMember[] = [],
    bytes = 0;
  const flush = () => {
    if (frame.length) observe.push(frame);
    frame = [];
    bytes = 0;
  };
  for (const batch of pending.slice(0, suffix)) {
    if (batch.whole) {
      if (batch.size > budget - bytes || batch.members.length > 128 - frame.length) flush();
      frame.push(...batch.members);
      bytes += batch.size;
    } else {
      for (const member of batch.members) {
        if (member.size > budget || standalone.has(imageMemberKey(member))) {
          flush();
          observe.push([member]);
          continue;
        }
        if (member.size > budget - bytes || frame.length === 128) flush();
        frame.push(member);
        bytes += member.size;
      }
    }
  }
  flush();
  return { observe, business: pending.slice(suffix).flatMap((b) => b.members) };
}
