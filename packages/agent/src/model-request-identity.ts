/** Native model attempts use a private versioned identity. Older runtimes require the
 * top-level requestId before treating an interrupted model attempt as effect-free. */
export function matchesModelRequestIdentity(source: Record<string, unknown>, executionId: unknown) {
  if (typeof executionId !== 'string' || !executionId || source.kind !== 'model_request')
    return false;
  if (!Object.hasOwn(source, 'nativeWebSearch')) return source.requestId === executionId;
  const search = source.nativeWebSearch;
  if (
    Object.hasOwn(source, 'requestId') ||
    !search ||
    typeof search !== 'object' ||
    Array.isArray(search)
  )
    return false;
  const binding = search as Record<string, unknown>;
  return (
    binding.version === 1 &&
    binding.dialect === 'openai-web-search' &&
    typeof binding.bindingDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(binding.bindingDigest) &&
    binding.requestId === executionId
  );
}
