import {
  decimal64Schema,
  evidenceOpenSchema,
  trajectoryReadRequestSchema,
  trajectorySnapshotSchema,
} from '@kite-ai/trajectory';
import type { IpcMain } from 'electron';
import { z } from 'zod';
import {
  type NativeTrajectoryFileReply,
  type NativeTrajectoryFileRequest,
  nativeTrajectoryFileChannel,
} from '../src/native-trajectory-file-bridge';
import { assertNativeSender } from './native-ipc';
import type { NativeRootWindow as BrowserWindow } from './native-root-window';
import type { NativeTrajectoryFiles } from './trajectory-files';

const id = z.string().uuid();
const requests = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('pick') }),
  z.strictObject({
    method: z.literal('events'),
    bundleId: id,
    request: trajectoryReadRequestSchema,
  }),
  z.strictObject({ method: z.literal('evidence.open'), bundleId: id, request: evidenceOpenSchema }),
  z.strictObject({
    method: z.literal('evidence.read'),
    bundleId: id,
    readId: id,
    offset: decimal64Schema,
    limit: z.number().int().min(1).max(65536).optional(),
  }),
  z.strictObject({ method: z.literal('evidence.close'), bundleId: id, readId: id }),
  z.strictObject({ method: z.literal('close'), bundleId: id }),
  z.strictObject({
    method: z.literal('export'),
    generation: z.number().int().positive(),
    snapshot: trajectorySnapshotSchema,
    includeEvidence: z.boolean(),
  }),
]);
export function decodeNativeTrajectoryFileRequest(value: unknown): NativeTrajectoryFileRequest {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 16384) throw Error('invalid_native_request');
  const decoded = requests.safeParse(value);
  if (!decoded.success) throw Error('invalid_native_request');
  return decoded.data;
}
/** File selection and package viewing are independent of the online caller and its Runtime. */
export function registerNativeTrajectoryFileIpc(options: {
  ipcMain: IpcMain;
  window(): BrowserWindow | undefined;
  rendererUrl: string;
  files: NativeTrajectoryFiles;
  channel?: string;
  pickPath(): Promise<string | null>;
  exportSnapshot(
    input: Extract<NativeTrajectoryFileRequest, { method: 'export' }>,
  ): Promise<boolean>;
}): void {
  options.ipcMain.handle(
    options.channel ?? nativeTrajectoryFileChannel,
    async (event, payload: unknown): Promise<NativeTrajectoryFileReply> => {
      try {
        assertNativeSender(event, options.window(), options.rendererUrl);
        const request = decodeNativeTrajectoryFileRequest(payload);
        if (request.method === 'pick') {
          const path = await options.pickPath();
          assertNativeSender(event, options.window(), options.rendererUrl);
          if (path === null) return { ok: true, value: null };
          const value = await options.files.open(path);
          assertNativeSender(event, options.window(), options.rendererUrl);
          return { ok: true, value };
        }
        if (request.method === 'export') {
          const exported = await options.exportSnapshot(request);
          assertNativeSender(event, options.window(), options.rendererUrl);
          return { ok: true, value: exported ? { kind: 'trajectory.bundle.exported' } : null };
        }
        const value = await options.files.invoke(request);
        assertNativeSender(event, options.window(), options.rendererUrl);
        return { ok: true, value };
      } catch (error) {
        const value =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : error instanceof Error
              ? error.message
              : '';
        return {
          ok: false,
          code:
            typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value)
              ? value
              : 'trajectory_bundle_unavailable',
        };
      }
    },
  );
}
