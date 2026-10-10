import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpAdapter, type McpLifecycleTransportPort } from './index';
import { McpStdioPortError } from './stdio-error';
import {
  copyMcpStdioEvidence,
  decodeMcpStdioProcessEvidence,
  isMcpStdioIdentity,
  type McpStdioProcessEvidenceV2,
  type McpStdioWindowsEvidence,
  mcpStdioKernelState,
} from './stdio-process-evidence';

export { McpStdioPortError } from './stdio-error';
/** Built leaf resolves only its packaged guardian; source callers must select a built asset. */
export function mcpStdioGuardianAsset(): string {
  if (!import.meta.url.endsWith('.js')) throw new McpStdioPortError('mcp_stdio_asset_unavailable');
  const path = fileURLToPath(
    new URL(
      process.platform === 'win32' ? './windows-stdio-guardian.js' : './stdio-guardian.js',
      import.meta.url,
    ),
  );
  if (!existsSync(path)) throw new McpStdioPortError('mcp_stdio_asset_unavailable');
  return path;
}
/** Installed Linux connections execute the sealed native owner; never a source or compiler fallback. */
export function mcpStdioLinuxAssets(): { initExecutable: string; bubblewrapPath: string } {
  if (process.platform !== 'linux' || !import.meta.url.endsWith('.js'))
    throw new McpStdioPortError('mcp_stdio_asset_unavailable');
  const initExecutable = fileURLToPath(new URL('./linux-stdio-init', import.meta.url));
  const bubblewrap = Bun.which('bwrap');
  if (!existsSync(initExecutable) || !bubblewrap)
    throw new McpStdioPortError('mcp_stdio_asset_unavailable');
  return { initExecutable, bubblewrapPath: realpathSync.native(bubblewrap) };
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
  /** Original host permissions and network; the PID namespace owns connection descendants. */
  linux?: { initExecutable: string; bubblewrapPath: string };
  /** Trusted private host base; the broker creates and removes its own 0700 directory. */
  controlBase?: string;
  allowedEnvNames: readonly string[];
  admit(binding: Binding, options: { signal: AbortSignal }): Promise<void>;
  /** Host-only source fence; cancellation/cleanup itself never depends on this check. */
  assertFresh?(binding: Binding, options: { signal: AbortSignal }): void;
  limits?: { frameBytes?: number; stderrBytes?: number; timeoutMs?: number; graceMs?: number };
}
/** Trusted platform supervision of this connection's owned process resources. */
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
    ![guardianPath, bun, options.controlBase ?? tmpdir()].every(isAbsolute) ||
    !guardianPath.endsWith('.js') ||
    (options.linux !== undefined &&
      ![options.linux.initExecutable, options.linux.bubblewrapPath].every(isAbsolute)) ||
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
      if (!['darwin', 'win32', 'linux'].includes(process.platform))
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
      if (process.platform === 'linux') {
        if (
          !options.linux ||
          ![options.linux.initExecutable, options.linux.bubblewrapPath].every(existsSync)
        )
          throw new McpStdioPortError('mcp_stdio_asset_unavailable');
        const { openLinuxStdio } = await import('./linux-stdio-port');
        return openLinuxStdio(binding, signal, server.configuration, options, {
          maximum,
          stderrMaximum,
          timeout,
          grace,
        });
      }
      if (process.platform === 'win32') {
        // No ambient COMSPEC or .cmd fallback: the configured native executable is explicit.
        if (!/\.exe$/i.test(server.configuration.command))
          throw new McpStdioPortError('mcp_stdio_executable_unsupported');
        return openWindowsStdio(binding, signal, server.configuration, options, {
          maximum,
          stderrMaximum,
          timeout,
          grace,
        });
      }
      const broker = spawn(bun, [guardianPath], {
        cwd: dirname(guardianPath),
        env: {},
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const processEvidence: McpStdioProcessEvidenceV2 = {
        version: 2,
        coverage: 'mcp-owned-coalition',
        ownerPid: process.pid,
        binding: {
          originalStoreId: binding.originalStoreId,
          sessionId: binding.sessionId,
          executionId: binding.executionId,
          serverId: binding.serverId,
          scopeId: binding.scopeId,
          configDigest: binding.configDigest,
        },
        broker: broker.pid
          ? {
              pid: broker.pid,
              parentPid: null,
              birth: null,
              unavailable: ['native_birth_unavailable'],
              exit: null,
              kernelState: 'unavailable',
            }
          : null,
        guardian: null,
        server: null,
        coalition: null,
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
          if (closing || !broker.stdin?.writable) throw new McpStdioPortError('mcp_stdio_closed');
          assertFresh?.(binding, { signal });
          const content = `${JSON.stringify(message)}\n`;
          if (Buffer.byteLength(content) > maximum)
            throw new McpStdioPortError('mcp_stdio_frame_limit');
          if (pendingWrites >= 32) throw new McpStdioPortError('mcp_stdio_write_capacity');
          pendingWrites++;
          try {
            await new Promise<void>((resolve, reject) =>
              broker.stdin!.write(
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
      broker.stdout!.on('data', (chunk: Buffer) => {
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
              frame.guardianPid === frame.guardian?.pid
            ) {
              if (
                !isMcpStdioIdentity(frame.broker, broker.pid!, process.pid) ||
                frame.coalition?.pid !== frame.guardianPid ||
                frame.registration?.removed !== false
              )
                throw Error('guardian_identity');
              const next = decodeMcpStdioProcessEvidence(
                {
                  ...processEvidence,
                  broker: {
                    ...frame.broker,
                    exit: null,
                    kernelState: mcpStdioKernelState(frame.broker),
                  },
                  guardian: frame.guardian,
                  server: frame.server,
                  coalition: {
                    id: frame.coalition.coalitionId,
                    guardianUniqueId: frame.coalition.uniqueId,
                    guardianPidVersion: frame.coalition.pidVersion,
                    claimTaskCount: 1,
                    terminalTaskCount: null,
                    processTreeStopped: false,
                    label: frame.registration.label,
                    domain: frame.registration.domain,
                    registrationRemoved: false,
                  },
                },
                processEvidence.binding,
                process.pid,
              );
              if (
                next?.version !== 2 ||
                !next.server ||
                next.server.pid !== frame.processGroupId ||
                next.server.exit !== null
              )
                throw Error('server_identity');
              processEvidence.broker = structuredClone(next.broker);
              processEvidence.guardian = structuredClone(next.guardian);
              processEvidence.coalition = structuredClone(next.coalition);
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
                {
                  ...processEvidence,
                  guardian: frame.guardian ?? processEvidence.guardian,
                  server: frame.server,
                  coalition: processEvidence.coalition
                    ? {
                        ...processEvidence.coalition,
                        processTreeStopped: frame.processTreeStopped === true,
                        terminalTaskCount: frame.terminalTaskCount ?? null,
                        registrationRemoved: frame.registrationRemoved === true,
                      }
                    : null,
                },
                processEvidence.binding,
                process.pid,
              );
              if (
                next?.version !== 2 ||
                (processEvidence.guardian &&
                  (next.guardian?.pid !== processEvidence.guardian.pid ||
                    JSON.stringify(next.guardian.birth) !==
                      JSON.stringify(processEvidence.guardian.birth))) ||
                (processEvidence.coalition &&
                  (frame.registration?.label !== processEvidence.coalition.label ||
                    frame.registration?.domain !== processEvidence.coalition.domain)) ||
                (processEvidence.server &&
                  (next.server?.pid !== processEvidence.server.pid ||
                    JSON.stringify(next.server.birth) !==
                      JSON.stringify(processEvidence.server.birth)))
              )
                throw Error('terminal_identity');
              processEvidence.guardian = structuredClone(next.guardian);
              processEvidence.server = structuredClone(next.server);
              processEvidence.coalition = structuredClone(next.coalition);
              groupStopped =
                frame.groupStopped &&
                next.coalition?.processTreeStopped === true &&
                next.coalition.registrationRemoved &&
                next.guardian?.kernelState === 'absent';
              closing = true;
              rejectReady(new McpStdioPortError('mcp_stdio_ended'));
            } else throw new Error('control_invalid');
          }
        } catch {
          malformed();
        }
      });
      broker.stdin!.on('error', () => {
        rejectReady(new McpStdioPortError('mcp_stdio_control_failed'));
      });
      broker.stderr!.resume();
      broker.on('error', () => rejectReady(new McpStdioPortError('mcp_stdio_guardian_failed')));
      let brokerExit: { code: number | null; signal: string | null; reaped: true } | null = null;
      broker.once('exit', (code, signal) => {
        brokerExit = { code, signal, reaped: true };
      });
      broker.once('close', () => {
        if (processEvidence.broker) {
          processEvidence.broker.exit = brokerExit;
          processEvidence.broker.kernelState = mcpStdioKernelState(processEvidence.broker);
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
          if (broker.stdin?.writable)
            broker.stdin.write(`${JSON.stringify({ type: 'cancel', nonce })}\n`);
          let stopTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              stopped.then((proof) => ({
                status: proof.supervision === 'ended' ? ('stopped' as const) : ('unknown' as const),
              })),
              new Promise<{ status: 'unknown' }>((resolve) => {
                stopTimer = setTimeout(() => {
                  broker.stdin?.end();
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
      broker.stdin!.write(
        `${JSON.stringify({ ...server.configuration, type: 'start', nonce, controlBase: options.controlBase ?? tmpdir(), graceMs: grace, stderrBytes: stderrMaximum, frameBytes: maximum })}\n`,
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

// Unknown native closes retain the original ChildProcess and original observation HANDLE.
const windowsUnknownOwners = new Set<object>();
async function openWindowsStdio(
  binding: Binding,
  signal: AbortSignal,
  configuration: Configuration,
  options: McpStdioPortOptions,
  limits: { maximum: number; stderrMaximum: number; timeout: number; grace: number },
): Promise<Awaited<ReturnType<McpLifecycleTransportPort['open']>>> {
  const { retainWindowsOwnedProcessObservation } =
    require('../platform/process/windows-owned-child') as typeof import('../platform/process/windows-owned-child');
  const child = spawn(options.bunExecutable, [options.guardianPath], {
    cwd: dirname(options.guardianPath),
    env: {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const nonce = randomUUID();
  let observation: ReturnType<typeof retainWindowsOwnedProcessObservation> | undefined;
  let evidence: McpStdioWindowsEvidence = {
    version: 3,
    coverage: 'windows-job-members',
    ownerPid: process.pid,
    binding: {
      originalStoreId: binding.originalStoreId,
      sessionId: binding.sessionId,
      executionId: binding.executionId,
      serverId: binding.serverId,
      scopeId: binding.scopeId,
      configDigest: binding.configDigest,
    },
    guardian: null,
    server: null,
    job: null,
    closed: false,
    closeUnknown: false,
  };
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  let finish!: (proof: { supervision: 'ended' | 'unknown' }) => void;
  const stopped = new Promise<{ supervision: 'ended' | 'unknown' }>((resolve) => {
    finish = resolve;
  });
  let closing = false,
    started = false,
    finalUnknown = false,
    terminalSeen = false,
    treeStopped = false,
    actualClosed = false,
    sequence = 0,
    pendingBytes = 0,
    pendingWrites = 0;
  let exit: NonNullable<McpStdioWindowsEvidence['guardian']>['exit'] = null;
  let controlBuffer = Buffer.alloc(0),
    rpcBuffer = Buffer.alloc(0);
  const pending: JSONRPCMessage[] = [];
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<import('../extensions').StopConfirmation> | undefined;
  const owner = {
    child,
    get observation() {
      return observation;
    },
  };
  function unknown() {
    finalUnknown = true;
    closing = true;
    windowsUnknownOwners.add(owner);
    finish({ supervision: 'unknown' });
  }
  async function stop(): Promise<import('../extensions').StopConfirmation> {
    if (stopping) return stopping;
    closing = true;
    readyReject(new McpStdioPortError('mcp_stdio_closed'));
    stopping = (async () => {
      if (
        !actualClosed &&
        child.exitCode === null &&
        child.signalCode === null &&
        child.stdin?.writable
      )
        child.stdin.write(`${JSON.stringify({ type: 'cancel', nonce })}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          stopped.then((proof) => ({
            status: proof.supervision === 'ended' ? ('stopped' as const) : ('unknown' as const),
          })),
          new Promise<{ status: 'unknown' }>((resolve) => {
            timer = setTimeout(() => {
              child.stdin?.end();
              unknown();
              resolve({ status: 'unknown' });
            }, limits.grace + 4000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return stopping;
  }
  const transport: Transport = {
    async start() {
      if (started) throw new McpStdioPortError('mcp_stdio_already_started');
      started = true;
      await ready;
      if (closing) throw new McpStdioPortError('mcp_stdio_closed');
      for (const message of pending.splice(0)) transport.onmessage?.(message);
      pendingBytes = 0;
    },
    async send(message) {
      if (closing || !child.stdin?.writable) throw new McpStdioPortError('mcp_stdio_closed');
      options.assertFresh?.(binding, { signal });
      const content = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(content) > limits.maximum)
        throw new McpStdioPortError('mcp_stdio_frame_limit');
      if (pendingWrites >= 32) throw new McpStdioPortError('mcp_stdio_write_capacity');
      pendingWrites++;
      try {
        await new Promise<void>((resolve, reject) =>
          child.stdin!.write(`${JSON.stringify({ type: 'rpc', nonce, content })}\n`, (error) =>
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
  function rpc(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset),
        end = newline < 0 ? chunk.length : newline;
      if (rpcBuffer.length + end - offset > limits.maximum) throw Error('frame_limit');
      rpcBuffer = Buffer.concat([rpcBuffer, chunk.subarray(offset, end)]);
      if (newline < 0) break;
      const message = JSONRPCMessageSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rpcBuffer)),
      );
      rpcBuffer = Buffer.alloc(0);
      offset = newline + 1;
      if (started && transport.onmessage) transport.onmessage(message);
      else {
        pendingBytes += Buffer.byteLength(JSON.stringify(message));
        if (pending.length >= 32 || pendingBytes > limits.maximum) throw Error('queue_limit');
        pending.push(message);
      }
    }
  }
  child.stdout!.on('data', (chunk: Buffer) => {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset),
          end = newline < 0 ? chunk.length : newline;
        if (controlBuffer.length + end - offset > 64 * 1024) throw Error('control_limit');
        controlBuffer = Buffer.concat([controlBuffer, chunk.subarray(offset, end)]);
        if (newline < 0) break;
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(controlBuffer));
        controlBuffer = Buffer.alloc(0);
        offset = newline + 1;
        if (frame.nonce !== nonce || frame.sequence !== sequence + 1)
          throw Error('control_identity');
        sequence++;
        if (
          frame.type === 'rpc' &&
          typeof frame.content === 'string' &&
          frame.content.length <= 32768
        ) {
          if (terminalSeen) throw Error('rpc_after_terminal');
          rpc(Buffer.from(frame.content, 'base64'));
          continue;
        }
        if (terminalSeen) throw Error('duplicate_terminal');
        if (frame.type !== 'ready' && frame.type !== 'terminal') throw Error('control_invalid');
        if (
          !observation?.creationTime ||
          frame.guardian?.pid !== child.pid ||
          frame.guardian?.parentPid !== process.pid ||
          frame.guardian?.creationTime !== observation.creationTime
        )
          throw Error('guardian_identity');
        const native = frame.evidence;
        if (
          native?.version !== 1 ||
          native.coverage !== 'windows-job-members' ||
          Object.keys(native).sort().join(',') !== 'closeUnknown,closed,coverage,job,root,version'
        )
          throw Error('job_identity');
        const candidate: McpStdioWindowsEvidence = {
          ...evidence,
          guardian: {
            pid: child.pid!,
            parentPid: process.pid,
            creationTime: observation.creationTime,
            exit: null,
            kernelState: observation.inspect(),
            observationClosed: false,
          },
          server: native.root,
          job: native.job,
          closed: native.closed,
          closeUnknown: native.closeUnknown,
        };
        const decoded = decodeMcpStdioProcessEvidence(candidate, evidence.binding, process.pid);
        if (
          decoded?.version !== 3 ||
          (evidence.server &&
            (decoded.server?.pid !== evidence.server.pid ||
              decoded.server.creationTime !== evidence.server.creationTime))
        )
          throw Error('server_identity');
        if (frame.type === 'ready') {
          if (
            evidence.guardian ||
            closing ||
            decoded.guardian?.kernelState !== 'alive' ||
            !decoded.server ||
            decoded.server.waitConfirmed ||
            decoded.closed ||
            decoded.closeUnknown ||
            decoded.job?.treeStopped
          )
            throw Error('ready_invalid');
          evidence = structuredClone(decoded);
          readyResolve();
        } else {
          terminalSeen = true;
          closing = true;
          treeStopped =
            frame.treeStopped === true &&
            decoded.closed &&
            !decoded.closeUnknown &&
            decoded.job?.treeStopped === true &&
            decoded.job.activeProcesses === 0 &&
            decoded.server?.waitConfirmed === true;
          evidence = structuredClone(decoded);
          readyReject(new McpStdioPortError('mcp_stdio_ended'));
          if (!treeStopped) unknown();
        }
      }
    } catch {
      transport.onerror?.(new McpStdioPortError('mcp_stdio_protocol_invalid'));
      readyReject(new McpStdioPortError('mcp_stdio_protocol_invalid'));
      void stop();
    }
  });
  child.stderr!.resume();
  child.stdin!.on('error', () => {
    readyReject(new McpStdioPortError('mcp_stdio_control_failed'));
    void stop();
  });
  child.once('error', () => {
    readyReject(new McpStdioPortError('mcp_stdio_guardian_failed'));
    unknown();
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal, reaped: true };
  });
  const aborted = () => {
    void stop();
  };
  signal.addEventListener('abort', aborted, { once: true });
  child.once('close', () => {
    actualClosed = true;
    closing = true;
    signal.removeEventListener('abort', aborted);
    if (startTimer) clearTimeout(startTimer);
    readyReject(new McpStdioPortError('mcp_stdio_guardian_ended'));
    let confirmed = false;
    try {
      const state = observation?.inspect() ?? 'uncertain';
      if (evidence.guardian) {
        evidence.guardian.exit = exit;
        evidence.guardian.kernelState = state;
      }
      if (exit && state === 'dead') {
        observation!.close();
        if (evidence.guardian) evidence.guardian.observationClosed = true;
        confirmed = true;
      }
    } catch {
      windowsUnknownOwners.add(owner);
    }
    if (confirmed) {
      windowsUnknownOwners.delete(owner);
      finish({ supervision: !finalUnknown && treeStopped ? 'ended' : 'unknown' });
    } else unknown();
    transport.onclose?.();
  });
  try {
    if (!child.pid) throw Error('guardian_pid_unavailable');
    observation = retainWindowsOwnedProcessObservation(child.pid);
    if (!observation.creationTime || !observation.verify())
      throw Error('guardian_birth_unavailable');
    options.assertFresh?.(binding, { signal });
    if (signal.aborted) throw Error('aborted');
    child.stdin!.write(
      `${JSON.stringify({
        ...configuration,
        type: 'start',
        nonce,
        controlBase: options.controlBase ?? tmpdir(),
        graceMs: limits.grace,
        stderrBytes: limits.stderrMaximum,
        frameBytes: limits.maximum,
      })}\n`,
    );
    startTimer = setTimeout(() => {
      readyReject(new McpStdioPortError('mcp_stdio_ready_timeout'));
      void stop();
    }, limits.timeout);
    void ready.then(
      () => clearTimeout(startTimer),
      () => clearTimeout(startTimer),
    );
  } catch (error) {
    // No business frame was sent. Only the original directly spawned handle is signalled.
    try {
      child.kill();
    } catch {
      unknown();
    }
    await stop();
    throw error;
  }
  return { transport, stopped, stop, readProcessEvidence: () => copyMcpStdioEvidence(evidence) };
}
