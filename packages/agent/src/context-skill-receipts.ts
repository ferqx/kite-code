import type { ModelMessage } from '@kite-ai/ai';
import { type SkillReadSelection, skillKnowledgeSourceId } from './context';
import { canonicalJson } from './json';
import type { Store } from './storage/port';
import type { Json } from './storage/types';

interface SkillReadReceipt extends SkillReadSelection {
  sourceId: string;
  messageId: string;
  seq: string;
  executionId: string;
  alreadyLoaded: boolean;
  verifiedModelContentDigest?: string;
}

export interface SkillReceiptCursor {
  scope: string;
  upperSeq: bigint;
  receipts: SkillReadReceipt[];
}

export async function readSkillReceipts(
  store: Store,
  input: Parameters<Store['readRunSkillReceipts']>[0],
  executionRoot?: Json,
  cursor?: SkillReceiptCursor,
): Promise<readonly SkillReadReceipt[]> {
  const root = executionRoot === undefined ? undefined : canonicalJson(executionRoot);
  const scope = canonicalJson([
    input.expectedStoreId,
    input.sessionId,
    input.subjectId,
    input.selectionId,
    input.runId,
    root ?? null,
  ]);
  const upper = input.upperSeq === undefined ? undefined : BigInt(input.upperSeq);
  const cached = upper !== undefined && cursor?.scope === scope ? cursor : undefined;
  if (cached && upper !== undefined && cached.upperSeq >= upper)
    return cached.upperSeq === upper
      ? cached.receipts
      : cached.receipts.filter(({ seq }) => BigInt(seq) <= upper);

  const receipts: SkillReadReceipt[] = [];
  for (const { recordedSourceId, executionRoot, ...receipt } of await store.readRunSkillReceipts({
    ...input,
    ...(cached ? { afterSeq: String(cached.upperSeq) } : {}),
  })) {
    if (root !== undefined && canonicalJson(executionRoot) !== root) continue;
    const { skillId, path, catalogueDigest } = receipt;
    const sourceId = skillKnowledgeSourceId(skillId, path);
    const legacyResource =
      path !== undefined &&
      catalogueDigest === undefined &&
      recordedSourceId === `skill.resource:${skillId}:${path}`;
    if (recordedSourceId === sourceId || legacyResource) receipts.push({ ...receipt, sourceId });
  }
  if (cursor && upper !== undefined) {
    cursor.scope = scope;
    cursor.upperSeq = upper;
    if (cached) {
      for (const receipt of receipts) cached.receipts.push(receipt);
    } else cursor.receipts = receipts;
    return cursor.receipts;
  }
  return receipts;
}

export function latestSkillReceipts(
  receipts: readonly SkillReadReceipt[],
  throughSeq?: string,
): SkillReadReceipt[] {
  const latest = new Map<string, SkillReadReceipt>();
  for (const receipt of receipts) {
    if (throughSeq === undefined || BigInt(receipt.seq) <= BigInt(throughSeq)) {
      const previous = latest.get(receipt.sourceId);
      // A short acknowledgement cannot establish previously unseen knowledge.
      if (
        receipt.alreadyLoaded &&
        !/^[a-f0-9]{64}$/.test(receipt.verifiedModelContentDigest ?? '') &&
        (!previous ||
          previous.version !== receipt.version ||
          previous.catalogueDigest !== receipt.catalogueDigest)
      )
        continue;
      // Store returns receipt order. Move a repeated resource to its latest position.
      latest.delete(receipt.sourceId);
      latest.set(receipt.sourceId, receipt);
    }
  }
  return [...latest.values()];
}

export function skillReceiptMessage(receipt: SkillReadReceipt): ModelMessage {
  return {
    role: 'user',
    sourceIds: [receipt.executionId],
    content: [
      'Completed Skill read (historical execution data):',
      canonicalJson({
        tool: receipt.path === undefined ? 'load_skill' : 'read_skill_resource',
        skill_id: receipt.skillId,
        ...(receipt.path === undefined ? {} : { path: receipt.path }),
        outcome: 'succeeded',
        ...(receipt.alreadyLoaded ? { already_loaded: true } : {}),
      }),
      'Reuse the matching Skill knowledge when present in context. Continue from this completed step.',
    ].join('\n'),
  };
}
