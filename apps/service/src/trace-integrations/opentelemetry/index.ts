import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type OwnedProcessIdentity,
  observeOwnedProcessIdentity,
} from '@kite-ai/agent/process-observation';
import {
  type TraceDeliveryResult,
  type TraceEventBatch,
  validateDeliveryResult,
} from '@kite-ai/trajectory';
import { z } from 'zod';
import { type OtelAdapterAssets, verifyOtelAdapterAssets } from './assets';
import type { OtelExportOutcome, OtelSendAuthorization } from './exporter';
import type { OtelAdapterStore, OtelGrantStamp } from './store';

export { buildOtelAdapterAssets, type OtelAdapterAssets } from './assets';
export { type OtelIntegrationConfig, otelIntegrationConfigSchema } from './configuration';
export type { OtelGrantStamp } from './store';
export interface OtelSendRequest {
  taskId: string;
  revision: string;
  epoch: string;
  endpoint: string;
}
export interface OtelIntegrationOptions {
  installationId: string;
  path: string;
  endpoint: string;
  grant: OtelGrantStamp;
  assets: OtelAdapterAssets;
  sampleRate?: number;
  /** Host checks the current task/grant, exact Origin and target; credentials stay in trusted code. */
  authorizeSend(request: OtelSendRequest, signal: AbortSignal): Promise<OtelSendAuthorization>;
}
export interface OtelIntegration {
  readonly identity: OwnedProcessIdentity;
  accept(batch: TraceEventBatch): Promise<TraceDeliveryResult>;
  pump(): Promise<(OtelExportOutcome & { attempts: number; possibleDuplicate: boolean }) | null>;
  inspect(): Promise<ReturnType<OtelAdapterStore['inspect']>>;
  cancelTask(taskId: string): Promise<void>;
  setGrant(stamp: OtelGrantStamp): Promise<void>;
  readExitEvidence(): OtelAdapterExitEvidence;
  close(): Promise<void>;
}
export interface OtelAdapterExitEvidence {
  identity: OwnedProcessIdentity;
  exit: { code: number | null; signal: string | null; reaped: true } | null;
  stdinClosed: boolean;
  stdoutClosed: boolean;
  stderrClosed: boolean;
  confirmed: boolean;
}
const packetSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('result'),
    id: z.number().int().positive(),
    result: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('error'),
    id: z.number().int().positive(),
    code: z.string().regex(/^otel_[a-z_]{1,80}$/),
  }),
  z.strictObject({ type: z.literal('fatal'), code: z.string().regex(/^otel_[a-z_]{1,80}$/) }),
  z.strictObject({
    type: z.literal('authorize_send'),
    id: z.number().int().positive(),
    taskId: z.string().min(1).max(512),
    revision: z.string(),
    epoch: z.string(),
    endpoint: z.string().max(2048),
  }),
]);
const occupied = new Map<string, object>();
/** Trusted official SDK runs outside Service and outside the restricted third-party engine. */
export async function createOtelIntegration(
  options: OtelIntegrationOptions,
): Promise<OtelIntegration> {
  if (occupied.has(options.installationId)) throw Error('otel_adapter_scope_busy');
  const assets = verifyOtelAdapterAssets(options.assets);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-otel-adapter-'))),
    token = {};
  occupied.set(options.installationId, token);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      realpathSync.native(process.execPath),
      [
        '--no-env-file',
        '--no-install',
        `--config=${join(assets, 'empty-bunfig.toml')}`,
        `--tsconfig-override=${join(assets, 'empty-tsconfig.json')}`,
        join(assets, 'runner.js'),
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          TMPDIR: root,
          TZ: 'UTC',
          ...(process.platform === 'win32'
            ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
            : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  } catch (error) {
    occupied.delete(options.installationId);
    rmSync(root, { recursive: true });
    throw error;
  }
  const identity = child.pid
    ? observeOwnedProcessIdentity(child.pid)
    : { pid: 0, birth: null, parentPid: null, unavailable: ['spawn_pending'] };
  let grant = { ...options.grant },
    closed = false,
    sequence = 0,
    buffer = Buffer.alloc(0),
    stderrBytes = 0,
    retiring = false,
    stdinClosed = false,
    stdoutClosed = false,
    stderrClosed = false;
  let exit: OtelAdapterExitEvidence['exit'] = null;
  const readExitEvidence = (): OtelAdapterExitEvidence => ({
    identity,
    exit,
    stdinClosed,
    stdoutClosed,
    stderrClosed,
    confirmed: exit !== null && stdinClosed && stdoutClosed && stderrClosed,
  });
  const stoppedTasks = new Set<string>(),
    abort = new AbortController();
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const rejectAll = (code: string) => {
    for (const target of pending.values()) {
      clearTimeout(target.timer);
      target.reject(Error(code));
    }
    pending.clear();
  };
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  child.once('error', () => {
    rejectAll('otel_adapter_spawn_failed');
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal, reaped: true };
  });
  child.stdin.once('close', () => {
    stdinClosed = true;
  });
  child.stdout.once('close', () => {
    stdoutClosed = true;
  });
  child.stderr.once('close', () => {
    stderrClosed = true;
  });
  child.once('close', () => {
    closed = true;
    abort.abort();
    rejectAll('otel_adapter_closed');
    resolveExit();
  });
  const send = (packet: unknown) => {
    const bytes = `${JSON.stringify(packet)}\n`;
    if (Buffer.byteLength(bytes) > 768 * 1024 || closed || retiring || child.stdin.destroyed)
      throw Error('otel_adapter_unavailable');
    child.stdin.write(bytes);
  };
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > 1024 * 1024) {
      rejectAll('otel_protocol_limit');
      child.kill('SIGKILL');
      return;
    }
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      try {
        const packet = packetSchema.parse(JSON.parse(line.toString()));
        if (packet.type === 'fatal') {
          rejectAll(packet.code);
          child.kill('SIGKILL');
          continue;
        }
        if (packet.type === 'authorize_send') {
          const request = {
            taskId: packet.taskId,
            revision: packet.revision,
            epoch: packet.epoch,
            endpoint: packet.endpoint,
          };
          void (async () => {
            try {
              if (
                closed ||
                retiring ||
                !grant.active ||
                grant.revision !== request.revision ||
                grant.epoch !== request.epoch ||
                request.endpoint !== options.endpoint ||
                stoppedTasks.has(request.taskId)
              )
                throw Error('otel_permission_revoked');
              const authorization = await options.authorizeSend(request, abort.signal);
              if (
                closed ||
                retiring ||
                !grant.active ||
                grant.revision !== request.revision ||
                grant.epoch !== request.epoch ||
                stoppedTasks.has(request.taskId)
              )
                throw Error('otel_permission_revoked');
              z.record(z.string().max(128), z.string().max(8192))
                .refine((value) => Object.keys(value).length <= 16)
                .parse(authorization.headers);
              send({ type: 'authorization', id: packet.id, allowed: true, authorization });
            } catch {
              if (!closed) {
                try {
                  send({ type: 'authorization', id: packet.id, allowed: false });
                } catch {}
              }
            }
          })();
          continue;
        }
        const target = pending.get(packet.id);
        if (!target) continue;
        pending.delete(packet.id);
        clearTimeout(target.timer);
        if (packet.type === 'error') target.reject(Error(packet.code));
        else target.resolve(packet.result);
      } catch {
        rejectAll('otel_protocol_invalid');
        child.kill('SIGKILL');
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 65536) {
      rejectAll('otel_diagnostic_limit');
      child.kill('SIGKILL');
    }
  });
  child.stdin.on('error', () => rejectAll('otel_adapter_pipe_closed'));
  const request = (method: string, input: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('otel_adapter_timeout'));
        child.kill('SIGKILL');
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ type: 'request', id, method, input });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      // Seal all future sends before stopping this exact original process. Durable state
      // survives; already admitted network effects remain explicitly uncertain on reopen.
      retiring = true;
      abort.abort();
      if (!closed) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(Error('otel_adapter_exit_unconfirmed')), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (deadline) clearTimeout(deadline);
      }
      if (!readExitEvidence().confirmed) throw Error('otel_adapter_exit_unconfirmed');
      if (occupied.get(options.installationId) === token) occupied.delete(options.installationId);
      rmSync(root, { recursive: true });
    })();
    void closePromise.catch(() => {
      closePromise = undefined;
    });
    return closePromise;
  };
  try {
    await request('initialize', {
      path: options.path,
      installationId: options.installationId,
      endpoint: options.endpoint,
      grant,
      ...(options.sampleRate === undefined ? {} : { sampleRate: options.sampleRate }),
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    identity,
    async accept(batch) {
      if (!grant.active || retiring) throw Error('otel_permission_revoked');
      return validateDeliveryResult(await request('accept', batch), batch);
    },
    async pump() {
      return (await request('pump', null)) as Awaited<ReturnType<OtelIntegration['pump']>>;
    },
    async inspect() {
      return (await request('inspect', null)) as ReturnType<OtelAdapterStore['inspect']>;
    },
    async cancelTask(taskId) {
      stoppedTasks.add(taskId);
      await request('cancel', taskId);
    },
    async setGrant(stamp) {
      const previous = grant;
      grant = { ...stamp };
      await request('grant', grant);
      if (!stamp.active || stamp.revision !== previous.revision || stamp.epoch !== previous.epoch)
        await close();
    },
    close,
    readExitEvidence,
  };
}
