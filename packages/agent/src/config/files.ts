import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { applyEdits, modify, type ParseError, parse, visit } from 'jsonc-parser';
import {
  acquireFileLock,
  assertLiveLock,
  LockBusyError,
  type WindowsPathSecurity,
} from '../platform/locks';
import { defaultWindowsPathSecurity, privateDirectory } from '../platform/windows-path-security';
import {
  assertJson,
  assertNoCredentialBody,
  ConfigurationError,
  type Json,
  type JsonObject,
  object,
} from './types';
export interface ConfigurationDocument {
  readonly path: string;
  readonly exists: boolean;
  readonly etag: string;
  readonly value: JsonObject;
}
export interface ConfigurationFileOptions {
  path: string;
  maxBytes?: number;
  windowsPathSecurity?: WindowsPathSecurity;
  /** Trusted host policy. Workspace declarations are untrusted scope content by default. */
  windowsPathPolicy?: 'scope' | 'private';
}
export type ConfigurationEdit =
  | { kind: 'set'; path: readonly (string | number)[]; value: Json }
  | { kind: 'remove'; path: readonly (string | number)[] };
const missingEtag = createHash('sha256').update('configuration:absent:v1').digest('hex');
function limit(options: ConfigurationFileOptions) {
  const bytes = options.maxBytes ?? 1048576;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 8388608)
    throw new ConfigurationError('configuration_limit');
  return bytes;
}
function hostPath(path: string) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0'))
    throw new ConfigurationError('invalid_configuration_path');
  return resolve(path);
}
function parseDocument(text: string): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  const keys: Set<string>[] = [];
  let duplicate = false;
  visit(
    text,
    {
      onObjectBegin() {
        keys.push(new Set());
      },
      onObjectProperty(name) {
        const scope = keys[keys.length - 1]!;
        if (scope.has(name)) duplicate = true;
        scope.add(name);
      },
      onObjectEnd() {
        keys.pop();
      },
    },
    { allowTrailingComma: true },
  );
  if (errors.length || duplicate) throw new ConfigurationError('invalid_jsonc');
  try {
    return object(value);
  } catch {
    throw new ConfigurationError('invalid_jsonc');
  }
}
function readRaw(path: string, maxBytes: number, privateFile = false) {
  let fd: number | undefined;
  try {
    if (process.platform === 'win32') {
      const content = defaultWindowsPathSecurity()!.readScopeFile(path, maxBytes, privateFile);
      if (content === null)
        return { exists: false, text: '{}', etag: missingEtag, bytes: Buffer.alloc(0) };
      const bytes = Buffer.from(content);
      return {
        exists: true,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        bytes,
        etag: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    if (!existsSync(path)) {
      // existsSync follows a dangling symlink; lstat preserves that rejection.
      try {
        lstatSync(path);
        throw new ConfigurationError('configuration_path_unsafe');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return { exists: false, text: '{}', etag: missingEtag, bytes: Buffer.alloc(0) };
    }
    const initial = lstatSync(path);
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.nlink !== 1 ||
      initial.size > maxBytes
    )
      throw new ConfigurationError(
        initial.size > maxBytes ? 'configuration_limit' : 'configuration_path_unsafe',
      );
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      initial.dev !== opened.dev ||
      initial.ino !== opened.ino
    )
      throw new ConfigurationError('configuration_path_unsafe');
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count <= maxBytes) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (!size) break;
      count += size;
    }
    if (count > maxBytes) throw new ConfigurationError('configuration_limit');
    const content = bytes.subarray(0, count);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    return {
      exists: true,
      text,
      bytes: content,
      etag: createHash('sha256').update(content).digest('hex'),
    };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof Error && error.message === 'windows_path_size_limit')
      throw new ConfigurationError('configuration_limit');
    throw new ConfigurationError('configuration_unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function windowsConfigPath(path: string, options: ConfigurationFileOptions): void {
  if (process.platform !== 'win32') return;
  const native = defaultWindowsPathSecurity()!;
  native.verifyPath(path);
  if (
    options.windowsPathPolicy !== undefined &&
    !['scope', 'private'].includes(options.windowsPathPolicy)
  )
    throw new ConfigurationError('configuration_unavailable');
  if (existsSync(dirname(path))) {
    if (options.windowsPathPolicy === 'private') native.verifyDirectory(dirname(path));
    else native.verifyScopeDirectory(dirname(path));
  }
  if (options.windowsPathPolicy === 'private' && existsSync(path)) native.verifyFile(path);
  if (options.windowsPathSecurity && options.windowsPathSecurity !== native) {
    if (existsSync(dirname(path))) options.windowsPathSecurity.verifyDirectory(dirname(path));
    if (existsSync(path)) options.windowsPathSecurity.verifyFile(path);
  }
}
function configurationParent(path: string, options: ConfigurationFileOptions): void {
  if (process.platform === 'win32' && options.windowsPathPolicy !== 'private' && existsSync(path))
    defaultWindowsPathSecurity()!.verifyScopeDirectory(path);
  else privateDirectory(path, options.windowsPathSecurity);
}
function writeTemporary(path: string, bytes: Uint8Array): void {
  if (process.platform === 'win32') {
    defaultWindowsPathSecurity()!.writePrivateFile(path, bytes);
    return;
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Host-supplied scope path only. No configuration discovery or legacy fallback. */
export function readConfigurationFile(options: ConfigurationFileOptions): ConfigurationDocument {
  options = {
    ...options,
    windowsPathSecurity: options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  };
  const path = hostPath(options.path);
  windowsConfigPath(path, options);
  const raw = readRaw(path, limit(options), options.windowsPathPolicy === 'private');
  return { path, exists: raw.exists, etag: raw.etag, value: parseDocument(raw.text) };
}
/** Short nonblocking OS lock plus latest byte ETag; never lock while awaiting user/network. */
export function updateConfigurationFile(
  options: ConfigurationFileOptions & {
    ifMatch: string;
    operations: readonly ConfigurationEdit[];
    /** Trusted synchronous host checks under this target's short file lock. */
    validateCandidate?: (candidate: JsonObject) => void;
    validatePublication?: () => void;
  },
): ConfigurationDocument {
  options = {
    ...options,
    windowsPathSecurity: options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  };
  const requested = hostPath(options.path);
  const maxBytes = limit(options);
  if (
    !/^[0-9a-f]{64}$/.test(options.ifMatch) ||
    options.operations.length < 1 ||
    options.operations.length > 64
  )
    throw new ConfigurationError('invalid_configuration_edit');
  for (const edit of options.operations) {
    if (
      !['set', 'remove'].includes(edit.kind) ||
      !edit.path.length ||
      edit.path.length > 32 ||
      edit.path.some((part) =>
        typeof part === 'string'
          ? !part || ['__proto__', 'constructor', 'prototype'].includes(part)
          : !Number.isSafeInteger(part) || part < 0 || part > 4096,
      )
    )
      throw new ConfigurationError('invalid_configuration_edit');
    if (edit.kind === 'set') {
      assertJson(edit.value);
      assertNoCredentialBody(edit.value);
      const probe: JsonObject = {};
      let cursor = probe;
      for (const part of edit.path)
        if (typeof part === 'string') {
          const next: JsonObject = {};
          cursor[part] = next;
          cursor = next;
        }
      assertNoCredentialBody(probe);
    }
  }
  let lock: ReturnType<typeof acquireFileLock> | undefined;
  let temporary: string | undefined;
  let published = false;
  try {
    configurationParent(dirname(requested), options);
    const parent = realpathSync(dirname(requested));
    const path = join(parent, basename(requested));
    windowsConfigPath(path, options);
    lock = acquireFileLock(`${path}.lock`, 'exclusive', options.windowsPathSecurity);
    const original = readRaw(path, maxBytes, options.windowsPathPolicy === 'private');
    if (original.etag !== options.ifMatch) throw new ConfigurationError('configuration_conflict');
    parseDocument(original.text); // A broken document is never treated as empty.
    let text = original.text;
    for (const edit of options.operations)
      text = applyEdits(
        text,
        modify(text, [...edit.path], edit.kind === 'set' ? edit.value : undefined, {
          formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol: text.includes('\r\n') ? '\r\n' : '\n',
          },
        }),
      );
    if (Buffer.byteLength(text) > maxBytes) throw new ConfigurationError('configuration_limit');
    const candidate = parseDocument(text);
    options.validateCandidate?.(candidate);
    if (text === original.text) {
      options.validatePublication?.();
      return readConfigurationFile({ ...options, path });
    }
    temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
    writeTemporary(temporary, Buffer.from(text, 'utf8'));
    if (readRaw(path, maxBytes, options.windowsPathPolicy === 'private').etag !== original.etag)
      throw new ConfigurationError('configuration_conflict');
    options.validatePublication?.();
    if (process.platform === 'win32') {
      assertLiveLock(lock, `${path}.lock`, 'exclusive');
      windowsConfigPath(path, options);
      if (readRaw(path, maxBytes, options.windowsPathPolicy === 'private').etag !== original.etag)
        throw new ConfigurationError('configuration_conflict');
    }
    if (options.windowsPathSecurity) options.windowsPathSecurity.secureFile(temporary);
    renameSync(temporary, path);
    published = true;
    temporary = undefined;
    // POSIX directory sync makes publication durable; filesystem/SQLite are not one transaction.
    if (process.platform !== 'win32') {
      const directory = openSync(parent, constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    return readConfigurationFile({ ...options, path });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof LockBusyError) throw new ConfigurationError('configuration_busy');
    throw new ConfigurationError(
      published ? 'configuration_publication_uncertain' : 'configuration_unavailable',
    );
  } finally {
    if (temporary)
      try {
        unlinkSync(temporary);
      } catch {
        /* Failed temporary cleanup does not rewrite the original document. */
      }
    lock?.release();
  }
}

/** Diagnostic inspection exposes only parsed data or a public error, never malformed raw text. */
export function inspectConfigurationFile(options: ConfigurationFileOptions): {
  readonly path: string;
  readonly exists: boolean;
  readonly etag: string;
  readonly value: JsonObject | null;
  readonly error: string | null;
} {
  options = {
    ...options,
    windowsPathSecurity: options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  };
  const path = hostPath(options.path);
  windowsConfigPath(path, options);
  const raw = readRaw(path, limit(options), options.windowsPathPolicy === 'private');
  try {
    return {
      path,
      exists: raw.exists,
      etag: raw.etag,
      value: parseDocument(raw.text),
      error: null,
    };
  } catch (error) {
    if (error instanceof ConfigurationError && error.code === 'invalid_jsonc')
      return { path, exists: raw.exists, etag: raw.etag, value: null, error: error.code };
    throw error;
  }
}

/** Explicit repair only; preserves a private bounded copy of the exact invalid original. */
export function repairConfigurationFile(
  options: ConfigurationFileOptions & { ifMatch: string; value: JsonObject },
): ConfigurationDocument & { readonly backupRef: string } {
  options = {
    ...options,
    windowsPathSecurity: options.windowsPathSecurity ?? defaultWindowsPathSecurity(),
  };
  const requested = hostPath(options.path);
  const maxBytes = limit(options);
  object(options.value);
  assertNoCredentialBody(options.value);
  if (!/^[0-9a-f]{64}$/.test(options.ifMatch))
    throw new ConfigurationError('invalid_configuration_edit');
  const text = `${JSON.stringify(options.value, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new ConfigurationError('configuration_limit');
  let lock: ReturnType<typeof acquireFileLock> | undefined;
  let temporary: string | undefined;
  let published = false;
  try {
    const parent = realpathSync(dirname(requested));
    const path = join(parent, basename(requested));
    windowsConfigPath(path, options);
    lock = acquireFileLock(`${path}.lock`, 'exclusive', options.windowsPathSecurity);
    const original = readRaw(path, maxBytes, options.windowsPathPolicy === 'private');
    if (original.etag !== options.ifMatch) throw new ConfigurationError('configuration_conflict');
    let invalid = false;
    try {
      parseDocument(original.text);
    } catch (error) {
      invalid = error instanceof ConfigurationError && error.code === 'invalid_jsonc';
    }
    if (!original.exists || !invalid)
      throw new ConfigurationError('configuration_repair_not_required');
    const backupDirectory = join(parent, '.config-repair-backups');
    if (!existsSync(backupDirectory))
      privateDirectory(backupDirectory, options.windowsPathSecurity);
    const directory = lstatSync(backupDirectory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())))
    )
      throw new ConfigurationError('configuration_path_unsafe');
    defaultWindowsPathSecurity()?.verifyDirectory(backupDirectory);
    const backup = join(backupDirectory, `${basename(path)}.${original.etag}.invalid.jsonc`);
    if (!existsSync(backup)) {
      if (readdirSync(backupDirectory).length >= 16)
        throw new ConfigurationError('configuration_backup_limit');
      writeTemporary(backup, original.bytes);
    } else {
      if (readRaw(backup, maxBytes, true).etag !== original.etag)
        throw new ConfigurationError('configuration_path_unsafe');
      if (process.platform !== 'win32') chmodSync(backup, 0o600);
    }
    if (process.platform !== 'win32') {
      const backupFd = openSync(backupDirectory, constants.O_RDONLY);
      try {
        fsyncSync(backupFd);
      } finally {
        closeSync(backupFd);
      }
    }
    if (options.windowsPathSecurity) {
      options.windowsPathSecurity.secureFile(backup);
      options.windowsPathSecurity.verifyFile(backup);
    }
    temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
    writeTemporary(temporary, Buffer.from(text, 'utf8'));
    if (readRaw(path, maxBytes, options.windowsPathPolicy === 'private').etag !== original.etag)
      throw new ConfigurationError('configuration_conflict');
    if (process.platform === 'win32') {
      assertLiveLock(lock, `${path}.lock`, 'exclusive');
      windowsConfigPath(path, options);
    }
    if (options.windowsPathSecurity) options.windowsPathSecurity.secureFile(temporary);
    renameSync(temporary, path);
    published = true;
    temporary = undefined;
    if (process.platform !== 'win32') {
      const directoryFd = openSync(parent, constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    return { ...readConfigurationFile({ ...options, path }), backupRef: `sha256:${original.etag}` };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof LockBusyError) throw new ConfigurationError('configuration_busy');
    throw new ConfigurationError(
      published ? 'configuration_publication_uncertain' : 'configuration_unavailable',
    );
  } finally {
    if (temporary)
      try {
        unlinkSync(temporary);
      } catch {
        /* original publication is unaffected */
      }
    lock?.release();
  }
}
