import { existsSync, realpathSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import {
  PROTECTED_WORKSPACE_DIRECTORIES_V1,
  PROTECTED_WORKSPACE_FILE_PREFIXES_V1,
  PROTECTED_WORKSPACE_FILES_V1,
} from '@/core/policies/protected-path';
import type { FilesystemScope } from './types';

export interface SandboxProfileOptions {
  network?: 'disabled' | 'allow_all';
  filesystemScope?: Exclude<FilesystemScope, 'full_access'>;
  sandboxRuntimeDir?: string;
  runtimeReadOnlyRoots?: readonly string[];
}

/**
 * Generate a macOS Seatbelt profile from canonical filesystem identities.
 * The profile is an OS boundary: command text checks are defense in depth only.
 */
export function generateSandboxProfile(
  workspace: string,
  options: SandboxProfileOptions = {},
): string {
  const workspaceRoot = canonicalExistingPath(workspace);
  const runtimeRoot = options.sandboxRuntimeDir
    ? canonicalExistingPath(options.sandboxRuntimeDir)
    : undefined;
  const filesystemScope = options.filesystemScope ?? 'workspace_write';
  const runtimeReadOnlyRoots = canonicalizeReadOnlyRoots(options.runtimeReadOnlyRoots ?? []);

  return [
    SEATBELT_BASE_POLICY,
    fileReadPolicy(workspaceRoot, runtimeRoot, runtimeReadOnlyRoots),
    fileWritePolicy(workspaceRoot, runtimeRoot, filesystemScope),
    protectedPathPolicy(workspaceRoot),
    networkPolicy(options.network ?? 'disabled'),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Resolve symlinks and path aliases before emitting an allow rule. */
export function canonicalExistingPath(path: string): string {
  return realpathSync.native(resolve(path));
}

/**
 * Development executor roots for the currently running Bun installation.
 * Release consumers must additionally pin any other runtime roots they need.
 */
export function discoverRuntimeReadOnlyRoots(): string[] {
  const executables = [process.execPath, Bun.which('bun'), Bun.which('node')].filter(
    (path): path is string => path !== null,
  );
  return canonicalizeReadOnlyRoots(
    executables.flatMap((path) => [dirname(resolve(path)), dirname(realpathSync.native(path))]),
  );
}

function canonicalizeReadOnlyRoots(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(existsSync).map(canonicalExistingPath))];
}

/** Escape a canonical path for a Seatbelt string literal. */
function seatbeltString(path: string): string {
  return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function subpathFilter(path: string): string {
  return `(subpath "${seatbeltString(path)}")`;
}

function literalFilter(path: string): string {
  return `(literal "${seatbeltString(path)}")`;
}

/** Escape only the delimiter inside Seatbelt's #"..." regex literal. */
function seatbeltRegex(regex: string): string {
  return regex.replaceAll('"', '\\"');
}

function regexFilterForLiteralPrefix(path: string): string {
  const regex = `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`;
  return `(regex #"${seatbeltRegex(regex)}")`;
}

function caseInsensitiveRegexLiteral(path: string): string {
  return [...path]
    .map((character) => {
      if (/^[A-Za-z]$/.test(character)) {
        return `[${character.toLowerCase()}${character.toUpperCase()}]`;
      }
      return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
    })
    .join('');
}

function regexFilterForCaseInsensitiveIdentity(path: string, suffix: '' | '(/.*)?' | '.*'): string {
  const regex = `^${caseInsensitiveRegexLiteral(path)}${suffix}$`;
  return `(regex #"${seatbeltRegex(regex)}")`;
}

/** Static process/IPC rules; descendants inherit the same Seatbelt sandbox. */
const SEATBELT_BASE_POLICY = `(version 1)
(import "system.sb")
(deny default)

;; Child processes inherit this sandbox.
(allow process-exec)
(allow process-fork)
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

const SYSTEM_READ_ROOTS = [
  '/System',
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/usr/libexec',
  '/usr/share',
  '/Library/Developer',
  '/Applications/Xcode.app',
  '/private/etc/ssl',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/opt/homebrew/Cellar',
  '/opt/homebrew/opt',
  '/opt/homebrew/lib',
  '/opt/homebrew/share',
  '/opt/local/bin',
  '/opt/local/sbin',
  '/opt/local/lib',
  '/opt/local/share',
];

const SYSTEM_EXECUTABLE_ROOTS = [
  '/System',
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/usr/libexec',
  '/Library/Developer',
  '/Applications/Xcode.app',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/opt/homebrew/Cellar',
  '/opt/homebrew/opt',
  '/opt/homebrew/lib',
  '/opt/local/bin',
  '/opt/local/sbin',
  '/opt/local/lib',
];

const SYSTEM_READ_FILES = ['/private/var/select/sh'];

function fileReadPolicy(
  workspaceRoot: string,
  runtimeRoot: string | undefined,
  runtimeReadOnlyRoots: readonly string[],
): string {
  const canonicalSystemReadRoots = SYSTEM_READ_ROOTS.filter(existsSync).map(canonicalExistingPath);
  const canonicalSystemExecutableRoots =
    SYSTEM_EXECUTABLE_ROOTS.filter(existsSync).map(canonicalExistingPath);
  const roots = [
    ...new Set([workspaceRoot, runtimeRoot, ...runtimeReadOnlyRoots, ...canonicalSystemReadRoots]),
  ].filter((path): path is string => path !== undefined);
  const readFilters = [
    ...roots.map(subpathFilter),
    ...SYSTEM_READ_FILES.filter(existsSync).flatMap((path) => [
      literalFilter(resolve(path)),
      literalFilter(canonicalExistingPath(path)),
    ]),
  ].join('\n  ');
  const metadataFilters = [...new Set(roots.flatMap(pathAncestors))]
    .map(literalFilter)
    .join('\n  ');
  const executableFilters = [
    ...new Set([workspaceRoot, ...runtimeReadOnlyRoots, ...canonicalSystemExecutableRoots]),
  ]
    .map(subpathFilter)
    .join('\n  ');
  return `;; Read only the Workspace, controlled runtime temp, and system runtime dependencies.
(allow file-read*
  ${readFilters})
;; Runtime path resolution may stat only the ancestors of explicit allow roots.
(allow file-read-metadata
  ${metadataFilters})
;; Writable runtime temp is intentionally absent from executable-map roots.
(allow file-map-executable
  ${executableFilters})`;
}

function pathAncestors(path: string): string[] {
  const ancestors: string[] = [];
  let current = resolve(path);
  const root = parse(current).root;
  while (current !== root) {
    current = dirname(current);
    ancestors.push(current);
  }
  return ancestors;
}

function fileWritePolicy(
  workspaceRoot: string,
  runtimeRoot: string | undefined,
  filesystemScope: Exclude<FilesystemScope, 'full_access'>,
): string {
  const writableRoots = [runtimeRoot];
  if (filesystemScope === 'workspace_write') writableRoots.unshift(workspaceRoot);
  const filters = writableRoots
    .filter((path): path is string => path !== undefined)
    .map(subpathFilter);
  if (filters.length === 0) return '';
  return `;; Writes are limited to the selected Workspace scope and controlled runtime temp.
(allow file-write* file-write-create file-write-unlink file-ioctl
  ${filters.join('\n  ')})`;
}

function protectedPathPolicy(workspaceRoot: string): string {
  const directoryFilters = PROTECTED_WORKSPACE_DIRECTORIES_V1.map((path) =>
    subpathFilter(resolve(workspaceRoot, path)),
  );
  const fileFilters = PROTECTED_WORKSPACE_FILES_V1.map((path) =>
    literalFilter(resolve(workspaceRoot, path)),
  );
  const filePrefixFilters = PROTECTED_WORKSPACE_FILE_PREFIXES_V1.map((path) =>
    regexFilterForLiteralPrefix(resolve(workspaceRoot, path)),
  );
  // APFS/HFS+ commonly resolve case aliases to the same filesystem identity.
  // Keep the exact filters for a compact fast path, then add conservative
  // ASCII-case-insensitive filters so `.GIT`, `.Agents`, and `.ENV.*` cannot
  // bypass the native deny even on a differently configured Darwin volume.
  const caseAliasFilters = [
    ...PROTECTED_WORKSPACE_DIRECTORIES_V1.map((path) =>
      regexFilterForCaseInsensitiveIdentity(resolve(workspaceRoot, path), '(/.*)?'),
    ),
    ...PROTECTED_WORKSPACE_FILES_V1.map((path) =>
      regexFilterForCaseInsensitiveIdentity(resolve(workspaceRoot, path), ''),
    ),
    ...PROTECTED_WORKSPACE_FILE_PREFIXES_V1.map((path) =>
      regexFilterForCaseInsensitiveIdentity(resolve(workspaceRoot, path), '.*'),
    ),
  ];
  return `;; Protected paths deny model-driven reads and writes even inside the Workspace.
(deny file-read* file-map-executable file-write* file-write-create file-write-unlink file-ioctl
  ${[...directoryFilters, ...fileFilters, ...filePrefixFilters, ...caseAliasFilters].join('\n  ')})`;
}

function networkPolicy(mode: 'disabled' | 'allow_all'): string {
  if (mode === 'disabled') {
    return `;; Network disabled.
(deny network*)`;
  }
  return `;; Legacy development-only unrestricted network mode.
(allow network*)`;
}
