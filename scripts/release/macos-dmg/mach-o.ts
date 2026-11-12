import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

const thinMagic = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe]);

export function isMachO(path: string, size: number) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(24);
    const length = readSync(descriptor, header, 0, header.length, 0);
    if (length < 4) return false;
    const magic = header.readUInt32BE(0);
    if (thinMagic.has(magic)) return true;
    // A fat Mach-O and a Java class can share the first four bytes. Admit a
    // universal binary only when its first architecture points to Mach-O code.
    if (length < header.length || ![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
      return false;
    const swapped = magic === 0xbebafeca || magic === 0xbfbafeca;
    const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    const count = swapped ? header.readUInt32LE(4) : header.readUInt32BE(4);
    const offset = wide
      ? swapped
        ? header.readBigUInt64LE(16)
        : header.readBigUInt64BE(16)
      : BigInt(swapped ? header.readUInt32LE(16) : header.readUInt32BE(16));
    if (!count || offset < BigInt(8 + count * (wide ? 32 : 20)) || offset > BigInt(size - 4))
      return false;
    return (
      readSync(descriptor, header, 0, 4, Number(offset)) === 4 &&
      thinMagic.has(header.readUInt32BE(0))
    );
  } finally {
    closeSync(descriptor);
  }
}

export const launcherDeploymentTarget = '13.0';

/** Derive the package floor from the arm64 load commands of its actual payload. */
export function macosMinimumSystemVersion(
  root: string,
  files: readonly { path: string; size: number }[],
) {
  let minimum: string = launcherDeploymentTarget;
  const numeric = new Intl.Collator('en', { numeric: true });
  for (const file of files) {
    const path = join(root, file.path);
    if (!isMachO(path, file.size)) continue;
    const build = execFileSync('/usr/bin/xcrun', ['vtool', '-arch', 'arm64', '-show-build', path], {
      encoding: 'utf8',
    });
    const version =
      /^\s*platform MACOS\s*\n\s*minos (\d+\.\d+(?:\.\d+)?)\s*$/mu.exec(build)?.[1] ??
      /^\s*cmd LC_VERSION_MIN_MACOSX\s*\n\s*cmdsize \d+\s*\n\s*version (\d+\.\d+(?:\.\d+)?)\s*$/mu.exec(
        build,
      )?.[1];
    if (!version) throw Error(`macos_dmg_deployment_target_missing:${file.path}`);
    if (numeric.compare(version, minimum) > 0) minimum = version;
  }
  return minimum;
}
