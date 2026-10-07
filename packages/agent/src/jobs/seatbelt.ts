import { existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

function literal(path: string): string {
  return `(literal "${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`;
}
function subpath(path: string): string {
  return `(subpath "${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`;
}

/** Fixed restricted macOS policy. No caller-supplied profile or network/filesystem mode. */
export function confinedProfile(
  workspace: string,
  temp: string,
  readonlyRoots: readonly string[],
  executables: readonly string[],
  protectedRoots: readonly string[],
): string {
  const system = [
    '/System',
    '/bin',
    '/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/usr/lib',
    '/usr/libexec',
    '/usr/share',
  ]
    .filter(existsSync)
    .map((path) => realpathSync.native(path));
  const systemFiles = ['/private/var/select/sh']
    .filter(existsSync)
    .flatMap((path) => [path, realpathSync.native(path)]);
  const reads = [...new Set([workspace, temp, ...system, ...readonlyRoots])];
  const ancestors = new Set<string>();
  for (const root of [...reads, ...executables, ...systemFiles]) {
    let current = root;
    while (dirname(current) !== current) {
      current = dirname(current);
      ancestors.add(current);
    }
  }
  return [
    SEATBELT_BASE_POLICY,
    `(allow file-read* ${reads.map(subpath).join(' ')} ${[...executables, ...systemFiles].map(literal).join(' ')})`,
    `(allow file-read-metadata ${[...ancestors].map(literal).join(' ')})`,
    `(allow file-map-executable ${system.map(subpath).join(' ')} ${executables.map(literal).join(' ')})`,
    `(allow file-write* file-write-create file-write-unlink file-ioctl ${[workspace, temp].map(subpath).join(' ')})`,
    `(deny file-write* file-write-create file-write-unlink file-ioctl ${readonlyRoots.map(subpath).join(' ')} ${executables.map(literal).join(' ')})`,
    protectedRoots.length
      ? `(deny file-read* file-read-metadata file-map-executable file-write* file-write-create file-write-unlink file-ioctl ${protectedRoots.map(subpath).join(' ')})`
      : '',
    `(deny file-map-executable ${subpath(temp)})`,
    `(deny process-exec ${subpath(temp)})`,
    '(deny network*)',
  ]
    .filter(Boolean)
    .join('\n');
}

export const SEATBELT_BASE_POLICY = `(version 1)
(import "system.sb")
(deny default)

;; Child processes inherit this sandbox.
(allow process-exec)
(deny process-fork)
(allow signal (target same-sandbox))

(allow sysctl-read
  (sysctl-name "hw.*")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.version")
  (sysctl-name "machdep.cpu.*")
  (sysctl-name "security.mac.amfi.lv.strict")
  (sysctl-name "sysctl.proc_translated")
  (sysctl-name "vm.loadavg"))

(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.logd")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.runningboard")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.analyticsd"))

(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name "apple.cfprefs."))
(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$$"))

(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write* file-ioctl (regex #"^/dev/ttys[0-9]+$$"))
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty"))`;
