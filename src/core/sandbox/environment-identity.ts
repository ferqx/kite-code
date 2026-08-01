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
    // os.version() is populated from the Windows version APIs by the runtime.
    // Avoid a synchronous PowerShell/CIM child process here: on a cold or busy
    // Windows host it can block production admission and exceed test deadlines.
    const windowsVersion = nodeOsVersion().trim();
    if (windowsVersion && windowsVersion !== 'unknown') {
      return { available: true, value: windowsVersion };
    }
  }
  const fallback = nodeOsVersion();
  if (fallback && fallback !== 'unknown') return { available: true, value: fallback };
  return { available: false, value: 'unavailable' };
}
