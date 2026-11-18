import { createHash } from 'node:crypto';
import type { ModelRequest } from '@kite-ai/ai';
import { AgentError } from '../storage/types';
export interface ImageWindowScope {
  version: 1;
  kind: 'business' | 'observation';
  route: string;
  members: readonly { executionId: string; ordinal: number; hash: string; size: number }[];
}
export function imageWindowScope(
  value: ImageWindowScope | undefined,
  request: ModelRequest,
): ImageWindowScope | undefined {
  if (value === undefined) return;
  const v = structuredClone(value);
  const invalid = () => {
    throw new AgentError('image_window_scope_invalid');
  };
  if (
    v.version !== 1 ||
    !['business', 'observation'].includes(v.kind) ||
    typeof v.route !== 'string' ||
    !v.route.length ||
    v.route.length > 1024 ||
    !Array.isArray(v.members) ||
    !v.members.length ||
    v.members.length > 128
  )
    invalid();
  const keys = new Set<string>();
  for (const m of v.members) {
    const key = JSON.stringify([m.executionId, m.ordinal]);
    if (
      typeof m.executionId !== 'string' ||
      !m.executionId.length ||
      !Number.isSafeInteger(m.ordinal) ||
      m.ordinal < 1 ||
      !/^[a-f0-9]{64}$/.test(m.hash) ||
      !Number.isSafeInteger(m.size) ||
      m.size <= 0 ||
      keys.has(key)
    )
      invalid();
    keys.add(key);
  }
  const boundMessages =
    v.kind === 'observation'
      ? request.messages
      : request.messages.filter(
          (m) =>
            m.role === 'tool' &&
            m.sourceIds?.length === 1 &&
            v.members.some((x) => x.executionId === m.sourceIds![0]),
        );
  const images = boundMessages.flatMap((m) => m.images ?? []);
  if (v.kind === 'business') {
    const expected = boundMessages.flatMap((m) =>
      (m.images ?? []).map((_, i) => ({ executionId: m.sourceIds![0]!, ordinal: i + 1 })),
    );
    if (
      expected.length !== v.members.length ||
      expected.some(
        (e, i) =>
          e.executionId !== v.members[i]!.executionId || e.ordinal !== v.members[i]!.ordinal,
      )
    )
      invalid();
  }
  if (images.length !== v.members.length) invalid();
  images.forEach((im, i) => {
    const bytes = Buffer.from(im.data, 'base64'),
      member = v.members[i]!;
    if (
      bytes.length !== member.size ||
      createHash('sha256').update(bytes).digest('hex') !== member.hash
    )
      invalid();
  });
  if (v.kind === 'observation' && request.tools.length) invalid();
  return v;
}
export function isImageObservation(source: unknown): boolean {
  return (
    !!source &&
    typeof source === 'object' &&
    (source as { imageWindow?: ImageWindowScope }).imageWindow?.kind === 'observation'
  );
}
