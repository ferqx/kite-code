import { randomUUID } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { StopConfirmation } from '../extensions';
import {
  type LinuxOwnedProgram,
  LinuxOwnedProgramStartError,
  startLinuxOwnedProgram,
} from '../platform/process/linux-owned-program';
import type { McpLifecycleTransportPort } from './lifecycle';
import { mcpStdioLinuxEvidenceEnded } from './linux-stdio-process-evidence';
import { McpStdioPortError } from './stdio-error';
import type { McpStdioPortOptions } from './stdio-port';
import {
  copyMcpStdioEvidence,
  decodeMcpStdioProcessEvidence,
  type McpStdioLinuxEvidence,
} from './stdio-process-evidence';

type Binding = Parameters<McpLifecycleTransportPort['open']>[0];
type Configuration = McpStdioPortOptions['servers'][number]['configuration'];
const unknownOwners = new Set<object>();

/** Direct original command, SDK stdin/stdout and a separate private native control channel. */
export function openLinuxStdio(
  binding: Binding,
  signal: AbortSignal,
  configuration: Configuration,
  options: McpStdioPortOptions,
  limits: { maximum: number; stderrMaximum: number; timeout: number; grace: number },
): Awaited<ReturnType<McpLifecycleTransportPort['open']>> {
  if (signal.aborted) throw new McpStdioPortError('mcp_stdio_aborted');
  options.assertFresh?.(binding, { signal });
  if (!options.linux) throw new McpStdioPortError('mcp_stdio_asset_unavailable');
  let owner: LinuxOwnedProgram;
  try {
    owner = startLinuxOwnedProgram({
      ...options.linux,
      executable: configuration.command,
      argv: configuration.args,
      cwd: configuration.cwd,
      env: configuration.env,
      nonce: randomUUID(),
      graceMs: limits.grace,
    });
  } catch (cause) {
    if (!(cause instanceof LinuxOwnedProgramStartError)) throw cause;
    owner = cause.cleanup;
  }
  const originalBinding: McpStdioLinuxEvidence['binding'] = {
    originalStoreId: binding.originalStoreId,
    sessionId: binding.sessionId,
    executionId: binding.executionId,
    serverId: binding.serverId,
    scopeId: binding.scopeId,
    configDigest: binding.configDigest,
  };
  const evidence = (): McpStdioLinuxEvidence => ({
    version: 4,
    coverage: 'mcp-owned-pid-namespace',
    ownerPid: process.pid,
    binding: { ...originalBinding },
    process: owner.readProcessEvidence(),
  });
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  let finishStopped!: (proof: { supervision: 'ended' | 'unknown' }) => void;
  const stopped = new Promise<{ supervision: 'ended' | 'unknown' }>((resolve) => {
    finishStopped = resolve;
  });
  let proof: { supervision: 'ended' | 'unknown' } | undefined;
  let unknownEvidence: McpStdioLinuxEvidence | undefined;
  let closing = false,
    started = false,
    pendingBytes = 0,
    pendingWrites = 0,
    stderrBytes = 0;
  let rpcBuffer = Buffer.alloc(0);
  const pending: JSONRPCMessage[] = [];
  let stopping: Promise<StopConfirmation> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const aborted = () => {
    void stop();
  };
  function finish(supervision: 'ended' | 'unknown') {
    if (proof) return;
    closing = true;
    proof = { supervision };
    if (startTimer) clearTimeout(startTimer);
    signal.removeEventListener('abort', aborted);
    readyReject(new McpStdioPortError('mcp_stdio_ended'));
    if (supervision === 'unknown') {
      unknownEvidence = evidence();
      unknownOwners.add({ owner, binding: originalBinding, keeper: setInterval(() => {}, 60000) });
    }
    finishStopped(proof);
    transport.onclose?.();
  }
  async function stop(): Promise<StopConfirmation> {
    if (stopping) return stopping;
    closing = true;
    readyReject(new McpStdioPortError('mcp_stdio_closed'));
    stopping = (async () => {
      // Native control does not queue behind a pending business stdin callback.
      void owner.cancel().catch(() => finish('unknown'));
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          stopped.then((receipt) => ({
            status: receipt.supervision === 'ended' ? ('stopped' as const) : ('unknown' as const),
          })),
          new Promise<{ status: 'unknown' }>((resolve) => {
            stopTimer = setTimeout(() => {
              finish('unknown');
              resolve({ status: 'unknown' });
            }, limits.grace + 4000);
          }),
        ]);
      } finally {
        if (stopTimer) clearTimeout(stopTimer);
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
      try {
        options.assertFresh?.(binding, { signal });
      } catch (cause) {
        void stop();
        throw cause;
      }
      for (const message of pending.splice(0)) transport.onmessage?.(message);
      pendingBytes = 0;
    },
    async send(message) {
      if (closing || signal.aborted) throw new McpStdioPortError('mcp_stdio_closed');
      options.assertFresh?.(binding, { signal });
      const content = Buffer.from(`${JSON.stringify(message)}\n`);
      if (content.length > limits.maximum) throw new McpStdioPortError('mcp_stdio_frame_limit');
      if (pendingWrites >= 32) throw new McpStdioPortError('mcp_stdio_write_capacity');
      pendingWrites++;
      try {
        await owner.writeStdin(content, () => {
          if (closing || signal.aborted) throw new McpStdioPortError('mcp_stdio_closed');
          options.assertFresh?.(binding, { signal });
        });
      } catch {
        throw new McpStdioPortError('mcp_stdio_write_failed');
      } finally {
        pendingWrites--;
      }
    },
    async close() {
      await stop();
    },
  };
  function malformed(code = 'mcp_stdio_protocol_invalid') {
    const failure = new McpStdioPortError(code);
    readyReject(failure);
    transport.onerror?.(failure);
    void stop();
  }
  owner.stdout.on('data', (chunk: Buffer) => {
    if (proof) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset),
          end = newline < 0 ? chunk.length : newline;
        if (rpcBuffer.length + end - offset + 1 > limits.maximum) throw Error('frame_limit');
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
    } catch {
      malformed();
    }
  });
  owner.stdout.once('end', () => {
    if (rpcBuffer.length) malformed();
  });
  owner.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > limits.stderrMaximum) malformed('mcp_stdio_stderr_limit');
  });
  owner.stdout.once('error', () => malformed());
  owner.stderr.once('error', () => malformed());
  startTimer = setTimeout(() => {
    readyReject(new McpStdioPortError('mcp_stdio_start_timeout'));
    void stop();
  }, limits.timeout);
  void owner.ready.then(
    () => {
      if (startTimer) clearTimeout(startTimer);
      const decoded = decodeMcpStdioProcessEvidence(evidence(), originalBinding, process.pid);
      if (
        decoded?.version !== 4 ||
        decoded.process.phase !== 'ready' ||
        !decoded.process.namespace?.root ||
        decoded.process.namespace.init.dead ||
        decoded.process.namespace.root.dead ||
        decoded.process.namespace.treeStopped ||
        decoded.process.namespace.root.waitReceipt ||
        decoded.process.fdClosed ||
        decoded.process.closeUnknown ||
        decoded.process.wrapper.exit ||
        decoded.process.wrapper.closed
      ) {
        malformed();
        return;
      }
      if (!closing) readyResolve();
    },
    () => {
      readyReject(new McpStdioPortError('mcp_stdio_guardian_failed'));
      void stop();
    },
  );
  void owner.completion.then(
    (result) => {
      const decoded = decodeMcpStdioProcessEvidence(evidence(), originalBinding, process.pid);
      finish(
        result.confirmed && decoded?.version === 4 && mcpStdioLinuxEvidenceEnded(decoded)
          ? 'ended'
          : 'unknown',
      );
    },
    () => finish('unknown'),
  );
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  return {
    transport,
    stop,
    stopped,
    readProcessEvidence: () => copyMcpStdioEvidence(unknownEvidence ?? evidence()),
  };
}
