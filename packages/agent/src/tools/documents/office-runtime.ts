import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officeBinaryAssets, officeFontAsset, officeVersion } from './office-assets-lock';
import { runWindowsOfficeProcess } from './windows-process';

export const officeEnvironment = () => ({
  OFFICECLI_NO_AUTO_RESIDENT: '1',
  OFFICECLI_SKIP_UPDATE: '1',
  OFFICECLI_NO_AUTO_INSTALL: '1',
});
export function resolveOfficeRuntimeAssets(trustedRoot?: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    join(here, 'office-assets'),
    join(here, 'tools/documents/office-assets'),
    resolve(here, '../../../dist/tools/documents/office-assets'),
  ];
  const root =
    trustedRoot ?? roots.find((path) => existsSync(join(path, 'manifest.json'))) ?? roots[2]!;
  return {
    root,
    officecli: join(root, process.platform === 'win32' ? 'officecli.exe' : 'officecli'),
    helper: join(dirname(root), 'kite-documents.js'),
    font: join(root, 'font.ttf'),
    previewAssets: join(root, 'katex'),
  };
}
export function officeShellEnvironment() {
  const assets = resolveOfficeRuntimeAssets();
  return {
    ...officeEnvironment(),
    KITE_DOCUMENTS_BUN: process.execPath,
    KITE_OFFICECLI: assets.officecli,
    KITE_DOCUMENTS_HELPER: assets.helper,
  };
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function verifyOfficeRuntimeAssets(trustedRoot?: string) {
  const assets = resolveOfficeRuntimeAssets(trustedRoot);
  const binary = officeBinaryAssets[`${process.platform}-${process.arch}`];
  if (!binary || (process.platform === 'win32' && process.arch !== 'x64'))
    throw Error('office_platform_not_qualified');
  if (
    digest(await readFile(assets.officecli)) !== binary.sha256 ||
    digest(await readFile(assets.font)) !== officeFontAsset.sha256
  )
    throw Error('office_asset_checksum_mismatch');
  const manifest = JSON.parse(readFileSync(join(assets.root, 'manifest.json'), 'utf8'));
  if (manifest.officeVersion !== officeVersion) throw Error('office_asset_version_mismatch');
  return assets;
}
export interface OfficeProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type OfficeRunner = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<OfficeProcessResult>;
/** Direct helper child: the enclosing Shell owns the process tree. Host preview must supply its owned runner. */
export async function runOfficeCLI(input: {
  args: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OfficeProcessResult> {
  const timeout = input.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
    throw Error('office_timeout_invalid');
  input.signal?.throwIfAborted();
  const assets = await verifyOfficeRuntimeAssets();
  input.signal?.throwIfAborted();
  if (process.platform === 'win32')
    return runWindowsOfficeProcess(assets.officecli, input.args, {
      env: { ...process.env, ...officeEnvironment() },
      signal: input.signal,
      timeoutMs: timeout,
    });
  const child = spawn(assets.officecli, [...input.args], {
    env: { ...process.env, ...officeEnvironment() },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let closed = false;
  const exit = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      closed = true;
      resolve(code);
    }),
  );
  const failed = new Promise<never>((_, reject) => child.once('error', reject));
  void failed.catch(() => {});
  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal?.reason ?? Error('office_cancelled'));
  const timer = setTimeout(() => controller.abort(Error('office_timeout')), timeout);
  input.signal?.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const abort = () => {
    if (!closed) child.kill('SIGKILL');
  };
  controller.signal.addEventListener('abort', abort, { once: true });
  async function collect(stream: AsyncIterable<Uint8Array>) {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        controller.abort(Error('office_diagnostic_limit'));
        throw Error('office_diagnostic_limit');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const io = [collect(child.stdout), collect(child.stderr)];
  try {
    const [code, stdout, stderr] = await Promise.race([Promise.all([exit, ...io]), failed]);
    controller.signal.throwIfAborted();
    if (code === null) throw Error('office_process_failed');
    return { code: code as number, stdout: stdout as string, stderr: stderr as string };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abort);
    if (!closed) child.kill('SIGKILL');
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exit,
        new Promise<never>((_, reject) => {
          cleanupTimer = setTimeout(() => reject(Error('office_process_exit_unconfirmed')), 5000);
        }),
      ]);
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
    await Promise.allSettled(io);
  }
}
