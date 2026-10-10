import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertProfileAccess,
  type FileLock,
  type ProfileAccess,
  retainProfileTuiPrivateOperation,
} from '@kite-ai/agent/profile-access';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';

const names = [
  'caller-intents.json',
  'recovery.json',
  'tui.json',
  'file-recovery-intents.json',
  'mcp-selection-intents.json',
  'mcp-connection-intents.json',
  'mcp-reconnection-intents.json',
  'mcp-source-approval-intents.json',
  'mcp-source-mutation-intents.json',
] as const;
export type WindowsTuiPrivateFilename = (typeof names)[number];
const limit = 16 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function unknownClose(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'windows_path_security_close_failed' ||
      error.message === 'tui_private_close_unknown' ||
      (error instanceof AggregateError && error.errors.some(unknownClose)) ||
      (error.cause !== undefined && unknownClose(error.cause)))
  );
}
function present(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function selected(access: ProfileAccess, filename: WindowsTuiPrivateFilename) {
  if (process.platform !== 'win32') throw Error('tui_private_platform_unsupported');
  if (!names.includes(filename)) throw Error('tui_private_filename_invalid');
  return { parent: join(access.profilePath, 'ui'), path: join(access.profilePath, 'ui', filename) };
}
/** Native private policy and original-H EOF; callers retain their own parse/grammar/etag rules. */
export function readWindowsTuiPrivateFile(
  access: ProfileAccess,
  filename: WindowsTuiPrivateFilename,
  maxBytes = limit,
): Buffer | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limit)
    throw Error('tui_private_capacity_invalid');
  const { parent, path } = selected(access, filename);
  const operation = retainProfileTuiPrivateOperation(access);
  let held:
    | ReturnType<
        NonNullable<ReturnType<typeof defaultWindowsPathSecurity>>['retainPrivateRecordFile']
      >
    | undefined;
  let result: Buffer | null = null,
    firstError: unknown;
  try {
    const security = defaultWindowsPathSecurity()!;
    security.verifyDirectory(access.profilePath);
    if (present(parent)) security.verifyDirectory(parent);
    if (present(path)) {
      held = security.retainPrivateRecordFile(path, maxBytes);
      result = Buffer.from(held.read());
      held.verify();
    }
  } catch (error) {
    firstError = error;
  }
  try {
    held?.close();
  } catch (cleanup) {
    firstError =
      firstError === undefined
        ? cleanup
        : new AggregateError([firstError, cleanup], 'tui_private_read_cleanup_failed');
  }
  if (unknownClose(firstError)) operation.keepUnknown(firstError);
  else operation.release();
  if (firstError !== undefined) throw firstError;
  return result;
}
/** Caller holds the original data EX. No await is permitted across final CAS and publication. */
export function publishWindowsTuiPrivateFile(input: {
  access: ProfileAccess;
  filename: WindowsTuiPrivateFilename;
  bytes: Uint8Array;
  writeLock: FileLock;
  expectedEtag: string | null;
  recheck: () => void;
}): void {
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.length > limit ||
    (input.expectedEtag !== null && !/^[a-f0-9]{64}$/.test(input.expectedEtag))
  )
    throw Error('tui_private_publication_invalid');
  const { parent, path } = selected(input.access, input.filename);
  const operation = retainProfileTuiPrivateOperation(input.access, input.writeLock);
  const temporary = join(parent, `.tui-private-${randomUUID()}.tmp`);
  let cleanup: { remove(): void } | undefined,
    published = false,
    firstError: unknown;
  try {
    const security = defaultWindowsPathSecurity()!;
    security.verifyDirectory(input.access.profilePath);
    privateDirectory(parent);
    cleanup = security.writePrivateRecordFile(temporary, input.bytes);
    const temporaryRead = security.retainPrivateRecordFile(temporary, limit);
    let readError: unknown;
    try {
      if (!Buffer.from(temporaryRead.read()).equals(input.bytes))
        throw Error('tui_private_readback_changed');
      temporaryRead.verify();
    } catch (error) {
      readError = error;
    }
    try {
      temporaryRead.close();
    } catch (error) {
      readError =
        readError === undefined
          ? error
          : new AggregateError([readError, error], 'tui_private_readback_cleanup_failed');
    }
    if (readError !== undefined) throw readError;
    const validation: unknown = input.recheck();
    if (validation && typeof Reflect.get(Object(validation), 'then') === 'function') {
      void Promise.resolve(validation).catch(() => {});
      throw Error('tui_private_async_recheck_invalid');
    }
    const original = readWindowsTuiPrivateFile(input.access, input.filename);
    if ((original === null ? null : sha(original)) !== input.expectedEtag)
      throw Error('tui_private_publication_changed');
    assertProfileAccess(input.access);
    security.movePrivateEntry(temporary, path, true);
    published = true;
    const actual = readWindowsTuiPrivateFile(input.access, input.filename);
    if (!actual?.equals(input.bytes)) throw Error('tui_private_published_readback_changed');
  } catch (error) {
    firstError = error;
  }
  if (!published && cleanup && !unknownClose(firstError)) {
    try {
      cleanup.remove();
    } catch (error) {
      firstError =
        firstError === undefined
          ? error
          : new AggregateError([firstError, error], 'tui_private_temporary_cleanup_failed');
    }
  }
  if (unknownClose(firstError)) operation.keepUnknown(firstError);
  else operation.release();
  if (firstError !== undefined) throw firstError;
}
