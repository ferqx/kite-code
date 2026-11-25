// Keep Win32's DOS normalization for ambiguous and non-local names. Extended
// paths are an internal API detail and never become an install identity.
export function windowsLocalFilePath(path: string): string {
  if (
    path.length >= 248 &&
    /^[a-zA-Z]:\\/u.test(path) &&
    path
      .slice(3)
      .split('\\')
      .every(
        (part) =>
          part.length > 0 &&
          part.length <= 255 &&
          !/[<>:"/|?*]|[. ]$/u.test(part) &&
          [...part].every((character) => character.charCodeAt(0) >= 32) &&
          !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
      )
  ) {
    return `\\\\?\\${path}`;
  }
  return path;
}
