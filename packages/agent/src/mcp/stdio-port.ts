import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpAdapter, type McpLifecycleTransportPort } from './index';
import {
  copyMcpStdioEvidence,
  decodeMcpStdioProcessEvidence,
  isMcpStdioIdentity,
  type McpStdioProcessEvidence,
  mcpStdioKernelState,
} from './stdio-process-evidence';

export class McpStdioPortError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
/** Built leaf resolves only its packaged guardian; source callers must select a built asset. */
export function mcpStdioGuardianAsset(): string {
  if (!import.meta.url.endsWith('.js')) throw new McpStdioPortError('mcp_stdio_asset_unavailable');
  const path = fileURLToPath(new URL('./stdio-guardian.js', import.meta.url));
  if (!existsSync(path)) throw new McpStdioPortError('mcp_stdio_asset_unavailable');
  return path;
}
type Binding = Parameters<McpLifecycleTransportPort['open']>[0];
type Configuration = {
  type: 'stdio';
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};
export interface McpStdioPortOptions {
  servers: readonly { id: string; configuration: Configuration }[];
  guardianPath: string;
  bunExecutable: string;
  allowedEnvNames: readonly string[];
  admit(binding: Binding, options: { signal: AbortSignal }): Promise<void>;
  /** Host-only source fence; cancellation/cleanup itself never depends on this check. */
  assertFresh?(binding: Binding, options: { signal: AbortSignal }): void;
  limits?: { frameBytes?: number; stderrBytes?: number; timeoutMs?: number; graceMs?: number };
}
/** macOS inherited POSIX process-group supervision, not arbitrary daemon/network containment. */
export function createMcpStdioTransportPort(
  options: McpStdioPortOptions,
): McpLifecycleTransportPort {
  const guardianPath = options.guardianPath,
    bun = options.bunExecutable,
    maximum = options.limits?.frameBytes ?? 1024 * 1024,
    stderrMaximum = options.limits?.stderrBytes ?? 1024 * 1024,
    timeout = options.limits?.timeoutMs ?? 10000,
    grace = options.limits?.graceMs ?? 200,
    admit = options.admit;
  const assertFresh = options.assertFresh;
  if (
    ![guardianPath, bun].every(isAbsolute) ||
    !guardianPath.endsWith('.js') ||
    [maximum, stderrMaximum, timeout].some((n) => !Number.isSafeInteger(n) || n < 1) ||
    maximum > 1024 * 1024 ||
    stderrMaximum > 16 * 1024 * 1024 ||
    timeout > 60000 ||
    !Number.isSafeInteger(grace) ||
    grace < 0 ||
    grace > 5000 ||
    options.servers.length > 32 ||
    options.allowedEnvNames.length > 128
  )
    throw new McpStdioPortError('mcp_stdio_configuration_invalid');
  const envNames = new Set(options.allowedEnvNames);
  if (
    [...envNames].some(
      (name) =>
        !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) ||
        /SECRET|TOKEN|API_?KEY|PASSWORD|CREDENTIAL|PROXY|^(?:LD_|DYLD_|NODE_|BUN_)/i.test(name),
    )
  )
    throw new McpStdioPortError('mcp_stdio_environment_denied');
  const servers = new Map(
    options.servers.map((server) => {
      const configuration = structuredClone(server.configuration);
      if (
        configuration.type !== 'stdio' ||
        !isAbsolute(configuration.command) ||
        !isAbsolute(configuration.cwd) ||
        Buffer.byteLength(JSON.stringify(configuration)) > 256 * 1024 ||
        configuration.args.length > 128 ||
        configuration.args.some((arg) => typeof arg !== 'string' || arg.length > 8192) ||
        Object.keys(configuration.env).some((name) => !envNames.has(name)) ||
        Object.values(configuration.env).some(
          (value) => typeof value !== 'string' || value.length > 8192,
        )
      )
        throw new McpStdioPortError('mcp_stdio_configuration_invalid');
      return [
        server.id,
        {
          configuration,
          configDigest: createMcpAdapter({ id: server.id, transport: configuration }).getCatalogue()
            .configDigest,
        },
      ];
    }),
  );
  if (servers.size !== options.servers.length)
    throw new McpStdioPortError('mcp_stdio_configuration_invalid');
  return {
    async open(binding, { signal }) {
      if (process.platform !== 'darwin')
        throw new McpStdioPortError('mcp_stdio_platform_unsupported');
      const server = servers.get(binding.serverId);
      if (
        !server ||
        binding.configDigest !== server.configDigest ||
        createMcpAdapter({ id: binding.serverId, transport: binding.configuration }).getCatalogue()
          .configDigest !== server.configDigest ||
        binding.scopeId !==
          JSON.stringify([binding.originalStoreId, binding.sessionId, binding.serverId]) ||
        !binding.executionId ||
        !binding.originalStoreId ||
        !binding.sessionId
      )
        throw new McpStdioPortError('mcp_stdio_binding_invalid');
      if (signal.aborted) throw new McpStdioPortError('mcp_stdio_aborted');
      assertFresh?.(binding, { signal });
      let timer: ReturnType<typeof setTimeout> | undefined, abortAdmission!: () => void;
      try {
        await Promise.race([
          admit(binding, { signal }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new McpStdioPortError('mcp_stdio_admission_timeout')),
              timeout,
            );
            abortAdmission = () => reject(new McpStdioPortError('mcp_stdio_aborted'));
            signal.addEventListener('abort', abortAdmission, { once: true });
            if (signal.aborted) abortAdmission();
          }),
        ]);
      } catch {
        throw new McpStdioPortError('mcp_stdio_admission_denied');
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', abortAdmission);
      }
      if (signal.aborted) throw new McpStdioPortError('mcp_stdio_aborted');
      assertFresh?.(binding, { signal });
      if (
        ![guardianPath, bun, server.configuration.command, server.configuration.cwd].every(
          existsSync,
        )
      )
        throw new McpStdioPortError('mcp_stdio_asset_unavailable');
      const guardian = spawn(bun, [guardianPath], {
        cwd: dirname(guardianPath),
        env: {},
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const processEvidence: McpStdioProcessEvidence = {
        version: 1,
        coverage: 'guardian-and-server-only',
        ownerPid: process.pid,
        binding: {
          originalStoreId: binding.originalStoreId,
          sessionId: binding.sessionId,
          executionId: binding.executionId,
          serverId: binding.serverId,
          scopeId: binding.scopeId,
          configDigest: binding.configDigest,
        },
        guardian: guardian.pid
          ? {
              pid: guardian.pid,
              parentPid: null,
              birth: null,
              unavailable: ['native_birth_unavailable'],
              exit: null,
              kernelState: 'unavailable',
            }
          : null,
        server: null,
      };
      const nonce = randomUUID();
      let controlBuffer = Buffer.alloc(0),
        rpcBuffer = Buffer.alloc(0),
        sequence = 0,
        groupStopped = false,
        closing = false,
        started = false,
        exited = false,
        pendingWrites = 0;
      let acknowledge!: () => void,
        rejectReady!: (error: Error) => void,
        end!: (proof: { supervision: 'ended' | 'unknown' }) => void;
      const ready = new Promise<void>((resolve, reject) => {
        acknowledge = resolve;
        rejectReady = reject;
      });
      void ready.catch(() => {});
      const stopped = new Promise<{ supervision: 'ended' | 'unknown' }>(
        (resolve) => (end = resolve),
      );
      const pending: JSONRPCMessage[] = [];
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingBytes = 0;
      const transport: Transport = {
        onclose: undefined,
        onerror: undefined,
        onmessage: undefined,
        async start() {
          if (started) throw new McpStdioPortError('mcp_stdio_already_started');
          started = true;
          await ready;
          if (closing) throw new McpStdioPortError('mcp_stdio_closed');
          for (const message of pending.splice(0)) transport.onmessage?.(message);
          pendingBytes = 0;
        },
        async send(message) {
          if (closing || !guardian.stdin?.writable) throw new McpStdioPortError('mcp_stdio_closed');
          assertFresh?.(binding, { signal });
          const content = `${JSON.stringify(message)}\n`;
          if (Buffer.byteLength(content) > maximum)
            throw new McpStdioPortError('mcp_stdio_frame_limit');
          if (pendingWrites >= 32) throw new McpStdioPortError('mcp_stdio_write_capacity');
          pendingWrites++;
          try {
            await new Promise<void>((resolve, reject) =>
              guardian.stdin!.write(
                `${JSON.stringify({ type: 'rpc', nonce, content })}\n`,
                (error) =>
                  error ? reject(new McpStdioPortError('mcp_stdio_write_failed')) : resolve(),
              ),
            );
          } finally {
            pendingWrites--;
          }
        },
        async close() {
          await stop();
        },
      };
      function malformed() {
        transport.onerror?.(new McpStdioPortError('mcp_stdio_protocol_invalid'));
        rejectReady(new McpStdioPortError('mcp_stdio_protocol_invalid'));
        void stop();
      }
      function rpc(chunk: Buffer) {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset),
            boundary = newline < 0 ? chunk.length : newline;
          if (rpcBuffer.length + boundary - offset > maximum) throw new Error('frame_limit');
          rpcBuffer = Buffer.concat([rpcBuffer, chunk.subarray(offset, boundary)]);
          if (newline < 0) break;
          const message = JSONRPCMessageSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rpcBuffer)),
          );
          rpcBuffer = Buffer.alloc(0);
          offset = newline + 1;
          if (started && transport.onmessage) transport.onmessage(message);
          else {
            pendingBytes += Buffer.byteLength(JSON.stringify(message));
            if (pending.length >= 32 || pendingBytes > maximum) throw new Error('queue_limit');
            pending.push(message);
          }
        }
      }
      guardian.stdout!.on('data', (chunk: Buffer) => {
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const newline = chunk.indexOf(10, offset),
              boundary = newline < 0 ? chunk.length : newline;
            if (controlBuffer.length + boundary - offset > 64 * 1024)
              throw new Error('control_limit');
            controlBuffer = Buffer.concat([controlBuffer, chunk.subarray(offset, boundary)]);
            if (newline < 0) break;
            const frame = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(controlBuffer),
            );
            controlBuffer = Buffer.alloc(0);
            offset = newline + 1;
            if (frame.nonce !== nonce || frame.sequence !== sequence + 1)
              throw new Error('control_identity');
            sequence++;
            if (
              frame.type === 'ready' &&
              Number.isSafeInteger(frame.processGroupId) &&
              frame.processGroupId > 1 &&
              frame.guardianPid === guardian.pid
            ) {
              if (!isMcpStdioIdentity(frame.guardian, guardian.pid!, process.pid))
                throw Error('guardian_identity');
              const next = decodeMcpStdioProcessEvidence(
                {
                  ...processEvidence,
                  guardian: { ...frame.guardian, exit: null, kernelState: 'unavailable' },
                  server: frame.server,
                },
                processEvidence.binding,
                process.pid,
              );
              if (
                !next?.server ||
                next.server.pid !== frame.processGroupId ||
                next.server.exit !== null
              )
                throw Error('server_identity');
              processEvidence.guardian = structuredClone(next.guardian);
              processEvidence.server = structuredClone(next.server);
              acknowledge();
            } else if (
              frame.type === 'rpc' &&
              typeof frame.content === 'string' &&
              frame.content.length <= 32768
            )
              rpc(Buffer.from(frame.content, 'base64'));
            else if (frame.type === 'terminal' && typeof frame.groupStopped === 'boolean') {
              const next = decodeMcpStdioProcessEvidence(
                { ...processEvidence, server: frame.server },
                processEvidence.binding,
                process.pid,
              );
              if (
                !next ||
                (processEvidence.server &&
                  (next.server?.pid !== processEvidence.server.pid ||
                    JSON.stringify(next.server.birth) !==
                      JSON.stringify(processEvidence.server.birth)))
              )
                throw Error('terminal_identity');
              processEvidence.server = structuredClone(next.server);
              groupStopped = frame.groupStopped;
              closing = true;
              rejectReady(new McpStdioPortError('mcp_stdio_ended'));
            } else throw new Error('control_invalid');
          }
        } catch {
          malformed();
        }
      });
      guardian.stdin!.on('error', () => {
        rejectReady(new McpStdioPortError('mcp_stdio_control_failed'));
      });
      guardian.stderr!.resume();
      guardian.on('error', () => rejectReady(new McpStdioPortError('mcp_stdio_guardian_failed')));
      let guardianExit: { code: number | null; signal: string | null; reaped: true } | null = null;
      guardian.once('exit', (code, signal) => {
        guardianExit = { code, signal, reaped: true };
      });
      guardian.once('close', () => {
        if (processEvidence.guardian) {
          processEvidence.guardian.exit = guardianExit;
          processEvidence.guardian.kernelState = mcpStdioKernelState(processEvidence.guardian);
        }
        exited = true;
        closing = true;
        signal.removeEventListener('abort', aborted);
        clearTimeout(startTimer);
        rejectReady(new McpStdioPortError('mcp_stdio_guardian_ended'));
        end({ supervision: groupStopped ? 'ended' : 'unknown' });
        transport.onclose?.();
      });
      let stopping: Promise<import('../extensions').StopConfirmation> | undefined;
      async function stop() {
        if (exited)
          return { status: groupStopped ? ('already_finished' as const) : ('unknown' as const) };
        if (stopping) return stopping;
        closing = true;
        rejectReady(new McpStdioPortError('mcp_stdio_closed'));
        stopping = (async () => {
          if (guardian.stdin?.writable)
            guardian.stdin.write(`${JSON.stringify({ type: 'cancel', nonce })}\n`);
          let stopTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              stopped.then((proof) => ({
                status: proof.supervision === 'ended' ? ('stopped' as const) : ('unknown' as const),
              })),
              new Promise<{ status: 'unknown' }>((resolve) => {
                stopTimer = setTimeout(() => {
                  guardian.stdin?.end();
                  resolve({ status: 'unknown' });
                }, grace + 4000);
              }),
            ]);
          } finally {
            if (stopTimer) clearTimeout(stopTimer);
          }
        })();
        return stopping;
      }
      const aborted = () => {
        void stop();
      };
      signal.addEventListener('abort', aborted, { once: true });
      try {
        assertFresh?.(binding, { signal });
      } catch (error) {
        await stop();
        throw error;
      }
      guardian.stdin!.write(
        `${JSON.stringify({ ...server.configuration, type: 'start', nonce, graceMs: grace, stderrBytes: stderrMaximum, frameBytes: maximum })}\n`,
      );
      startTimer = setTimeout(() => {
        rejectReady(new McpStdioPortError('mcp_stdio_ready_timeout'));
        void stop();
      }, timeout);
      void ready.then(
        () => clearTimeout(startTimer),
        () => clearTimeout(startTimer),
      );
      if (signal.aborted) void stop();
      return {
        transport,
        stopped,
        stop,
        readProcessEvidence() {
          return copyMcpStdioEvidence(processEvidence);
        },
      };
    },
  };
}
