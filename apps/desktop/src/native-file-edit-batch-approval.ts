const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function lineCounts(value: unknown) {
  const counts = object(value);
  const valid = (count: unknown): count is number =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  return valid(counts?.added) && valid(counts?.removed)
    ? { added: counts.added, removed: counts.removed }
    : undefined;
}

export function nativeFileEditBatchApproval(payload: unknown, original: unknown) {
  const value = object(payload);
  const input = object(original);
  if (
    value?.kind !== 'file_edit_batch@1' ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !Array.isArray(value.members) ||
    value.members.length < 2 ||
    value.members.length > 32 ||
    !input
  )
    return;
  const members: {
    callId: string;
    path: string;
    find: string;
    replace: string;
    replaceAll: boolean;
    counts?: ReturnType<typeof lineCounts>;
  }[] = [];
  const ids = new Set<string>();
  for (const raw of value.members) {
    const entry = object(raw);
    if (
      !entry ||
      typeof entry.callId !== 'string' ||
      !entry.callId ||
      ids.has(entry.callId) ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      typeof entry.find !== 'string' ||
      !entry.find ||
      typeof entry.replace !== 'string' ||
      typeof entry.replaceAll !== 'boolean'
    )
      return;
    ids.add(entry.callId);
    members.push({
      callId: entry.callId,
      path: entry.path,
      find: entry.find,
      replace: entry.replace,
      replaceAll: entry.replaceAll,
      counts: lineCounts(entry.counts),
    });
  }
  const first = members[0]!;
  if (
    first.path !== input.path ||
    first.find !== input.find ||
    first.replace !== input.replace ||
    first.replaceAll !== (input.replaceAll === true)
  )
    return;
  return members.map(({ callId, path, counts }) => ({ callId, path, counts }));
}
