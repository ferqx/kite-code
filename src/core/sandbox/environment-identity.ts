import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, version as nodeOsVersion, release } from 'node:os';

export interface ExecutionEnvironmentIdentityV1 {
  platform: NodeJS.Platform;
  osRelease: string;
  osVersion: string;
  arch: string;
  bunVersion: string;
  exactOsVersionAvailable: boolean;
}

/** Shared canonical identity producer for native evidence and runtime admission. */
export function readExecutionEnvironmentIdentityV1(): ExecutionEnvironmentIdentityV1 {
  const exactOsVersion = readExactOsVersion();
  return {
    platform: process.platform,
    osRelease: release(),
    osVersion: exactOsVersion.value,
    arch: arch(),
    bunVersion: Bun.version,
    exactOsVersionAvailable: exactOsVersion.available,
  };
}

function readExactOsVersion(): { available: boolean; value: string } {
  if (process.platform === 'darwin') {
    const product = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
    const build = spawnSync('/usr/bin/sw_vers', ['-buildVersion'], { encoding: 'utf8' });
    if (product.status === 0 && build.status === 0) {
      return { available: true, value: `macOS ${product.stdout.trim()} (${build.stdout.trim()})` };
    }
  } else if (process.platform === 'linux') {
    try {
      const fields = Object.fromEntries(
        readFileSync('/etc/os-release', 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => {
            const separator = line.indexOf('=');
            return [
              line.slice(0, separator),
              line
                .slice(separator + 1)
                .replace(/^"/, '')
                .replace(/"$/, ''),
            ];
          }),
      );
      const description = fields.PRETTY_NAME ?? fields.VERSION_ID;
      if (description) return { available: true, value: description };
    } catch {
      // Fall through to the runtime OS version.
    }
  } else if (process.platform === 'win32') {
    const script =
      '$os = Get-CimInstance Win32_OperatingSystem; "$($os.Caption) $($os.Version) build $($os.BuildNumber)"';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status === 0 && result.stdout.trim()) {
      return { available: true, value: result.stdout.trim() };
    }
  }
  const fallback = nodeOsVersion();
  if (fallback && fallback !== 'unknown') return { available: true, value: fallback };
  return { available: false, value: 'unavailable' };
}
