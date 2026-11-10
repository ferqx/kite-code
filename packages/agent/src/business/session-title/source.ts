import { canonicalJson } from '../../json';
import type { CommandRecord, Json } from '../../storage/types';

const fields = (value: Json): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** One provenance rule for the async factory and the synchronous final Store transaction. */
export function* originalTitleSource(
  command: CommandRecord,
): Generator<string, CommandRecord | null, CommandRecord | null> {
  const same = (item: CommandRecord) =>
    item.sessionId === command.sessionId &&
    item.originStoreId === command.originStoreId &&
    item.subjectId === command.subjectId;
  if (
    !['run.start', 'input.follow_up'].includes(command.kind) ||
    typeof fields(command.request).content !== 'string'
  )
    return null;
  const receipt = fields(command.receipt);
  const inputCommandId = receipt.humanInputCommandId ?? receipt.inputCommandId;
  if (typeof inputCommandId !== 'string' || typeof receipt.decisionCommandId !== 'string')
    return command;
  const raw = yield inputCommandId;
  const decision = yield receipt.decisionCommandId;
  const publicId = fields(raw?.request ?? null).publicCommandId;
  const original = typeof publicId === 'string' ? yield publicId : null;
  if (
    raw?.kind !== 'human.input' ||
    decision?.kind !== 'human.input.decision' ||
    !original ||
    !['run.start', 'input.follow_up'].includes(original.kind) ||
    [raw, decision, original].some((item) => !same(item)) ||
    fields(raw.receipt).decisionCommandId !== decision.id ||
    fields(raw.receipt).businessCommandId !== command.id ||
    fields(decision.receipt).businessCommandId !== command.id ||
    fields(original.receipt).humanInputCommandId !== raw.id ||
    fields(original.receipt).businessCommandId !== command.id ||
    canonicalJson(fields(raw.request).originalRequest ?? null) !==
      canonicalJson(original.request) ||
    fields(raw.request).content !== fields(command.request).content ||
    fields(original.request).content !== fields(command.request).content
  )
    return null;
  const clarificationId =
    fields(decision.request).clarifiesInputId ?? fields(raw.request).clarifiesInputId;
  if (typeof clarificationId !== 'string') return original;
  const first = yield clarificationId;
  const firstRequest = fields(first?.request ?? null),
    firstReceipt = fields(first?.receipt ?? null);
  const firstPublicId = firstRequest.publicCommandId;
  const firstPublic = typeof firstPublicId === 'string' ? yield firstPublicId : null;
  const firstPublicReceipt = fields(firstPublic?.receipt ?? null);
  const proposal = fields(fields(decision.request).proposal ?? null);
  if (
    first?.kind !== 'human.input' ||
    !firstPublic ||
    !['run.start', 'input.follow_up'].includes(firstPublic.kind) ||
    [first, firstPublic].some((item) => !same(item)) ||
    proposal.relation !== 'independent_work' ||
    proposal.purpose !== 'work' ||
    proposal.targetRootWorkCommandId !== null ||
    firstReceipt.state !== 'clarified' ||
    firstReceipt.clarifyingInputId !== raw.id ||
    firstReceipt.decisionCommandId !== decision.id ||
    firstReceipt.originalSelection !== null ||
    !Array.isArray(firstReceipt.candidateWorkCommandIds) ||
    firstReceipt.candidateWorkCommandIds.length !== 0 ||
    firstPublicReceipt.humanInputCommandId !== first.id ||
    firstPublicReceipt.reason !== 'clarified_by_input' ||
    firstPublicReceipt.clarifyingInputId !== raw.id ||
    canonicalJson(firstRequest.originalRequest ?? null) !== canonicalJson(firstPublic.request) ||
    firstRequest.content !== fields(firstPublic.request).content
  )
    return null;
  return firstPublic;
}
