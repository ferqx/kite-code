/** Portable single-component names for Profile-managed editable deliverables. */
export function isSessionOutputName(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{P}\p{S} ]{0,119}$/u.test(value) ||
    /[\\/:*?"<>|]/.test(value) ||
    /[. ]$/.test(value) ||
    Buffer.byteLength(value, 'utf8') > 240
  )
    return false;
  const stem = value.split('.')[0]!.toUpperCase();
  return !(['CON', 'PRN', 'AUX', 'NUL'].includes(stem) || /^(?:COM|LPT)[1-9¹²³]$/.test(stem));
}

/** Relative Profile paths only; the Store/Session hashes remain exact. */
export function isSessionOutputPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^files\/[a-f0-9]{64}\/[a-f0-9]{64}\/outputs\/(.+)$/u.exec(value);
  return !!match && isSessionOutputName(match[1]);
}

export function isManagedWorkingFilePath(value: unknown): value is string {
  return (
    isSessionOutputPath(value) ||
    (typeof value === 'string' &&
      /^files\/[a-f0-9]{64}\/[a-f0-9]{64}\/plans\/[a-f0-9]{64}\/plan\.md$/.test(value))
  );
}
