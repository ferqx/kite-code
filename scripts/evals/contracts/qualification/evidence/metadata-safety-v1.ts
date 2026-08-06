/**
 * Shared reject-list for diagnostic metadata. Qualification records retain
 * stable identifiers and digests, never endpoints, filesystem locations, or
 * opaque content-bearing strings. Keep this dependency neutral: it imports no
 * release evidence, route resolver, or runtime implementation.
 */
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
// Deliberately reserve URI/content schemes while retaining ordinary stable
// qualification IDs such as `authorization:approval` and `l0-receipt:…`.
const UNSAFE_URI_OR_CONTENT_SCHEME =
  /^(?:data|file|ftp|ftps|http|https|javascript|mailto|ssh|ws|wss):/i;

export function hasQualificationControlCharacterV1(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function isQualificationSafeMetadataValueV1(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !value.startsWith('/') &&
    !value.startsWith('~') &&
    !value.startsWith('\\') &&
    !WINDOWS_ABSOLUTE_PATH.test(value) &&
    !UNSAFE_URI_OR_CONTENT_SCHEME.test(value) &&
    !value.includes('..') &&
    !value.includes('://') &&
    !value.includes('?') &&
    !value.includes('#') &&
    !hasQualificationControlCharacterV1(value)
  );
}

/**
 * Identifiers additionally have a closed character grammar at their call
 * sites. This predicate supplies the privacy/safety portion that a regex
 * alone cannot express (for example `https://…` and `C:/…`).
 */
export function isQualificationSafeIdentifierV1(value: string): boolean {
  return isQualificationSafeMetadataValueV1(value);
}
