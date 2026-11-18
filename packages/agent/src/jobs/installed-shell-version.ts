/** Compare probed numeric versions, with a release newer than its prereleases. */
export function compareInstalledShellVersions(first: string, second: string): number {
  const parts = (version: string) => {
    const match = /^(\d+(?:\.\d+)*)(?:-([\w.-]+))?$/u.exec(version);
    if (!match) throw Error('shell_version_invalid');
    return { numbers: match[1]!.split('.').map(BigInt), prerelease: match[2]?.split('.') };
  };
  const a = parts(first);
  const b = parts(second);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index++) {
    const left = a.numbers[index] ?? 0n;
    const right = b.numbers[index] ?? 0n;
    if (left !== right) return left > right ? 1 : -1;
  }
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const ln = /^\d+$/u.test(left);
    const rn = /^\d+$/u.test(right);
    if (ln && rn) {
      if (BigInt(left) !== BigInt(right)) return BigInt(left) > BigInt(right) ? 1 : -1;
    } else if (ln !== rn) return ln ? -1 : 1;
    else return left > right ? 1 : -1;
  }
  return 0;
}
