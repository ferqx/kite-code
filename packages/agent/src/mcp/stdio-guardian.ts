import { type ChildProcess, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { removeRuntimeTemp } from '../jobs/launch-identity';
import {
  connectLaunchdControl,
  removeLaunchdRegistration,
  startLaunchdSupervisor,
} from '../platform/process/darwin-launchd-supervisor';
import { claimDarwinOwnedCoalition } from '../platform/process/darwin-owned-coalition';
import {
  type McpStdioProcessRecord,
  mcpStdioKernelState,
  observeMcpStdioIdentity,
} from './stdio-process-evidence';

interface Start {
  type: 'start';
  nonce: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  controlBase: string;
  graceMs: number;
  stderrBytes: number;
  frameBytes: number;
}
const launchdOwned = process.argv[2] === '--launchd-owned';
// The Service's direct child only brokers the private launchd channel.
const coalition = launchdOwned ? claimDarwinOwnedCoalition() : undefined;
const control = launchdOwned
  ? await connectLaunchdControl(process.argv[3]!, 'mcp', async (registration) => {
      // A broker can die between bootstrap and authentication. No business
      // child exists here; only the original exclusive guardian may clean up.
      if (!(await coalition!.stopTree(0)).confirmed) return;
      removeRuntimeTemp(registration.root);
      await removeLaunchdRegistration(registration);
    })
  : undefined;
const incoming = control?.socket ?? process.stdin;
const outgoing = control?.socket ?? process.stdout;
const brokerIdentity = launchdOwned ? undefined : observeMcpStdioIdentity(process.pid);
let start: Start | undefined,
  child: ChildProcess | undefined,
  buffer = Buffer.alloc(0),
  closing: Promise<void> | undefined,
  parentGone = false,
  sequence = 0,
  exited: Promise<void> | undefined,
  drained: Promise<unknown> | undefined,
  cancelling = false;
let bridge: Awaited<ReturnType<typeof startLaunchdSupervisor>> | undefined;
let bridgeStarting: Promise<void> | undefined;
let guardianSequence = 0;
let serverEvidence: McpStdioProcessRecord | null = null;
let serverExit: McpStdioProcessRecord['exit'] = null;
let guardianEvidence: McpStdioProcessRecord | undefined;
function evidence() {
  if (serverEvidence) serverEvidence.kernelState = mcpStdioKernelState(serverEvidence);
  return serverEvidence;
}
const CONTROL = 2 * 1024 * 1024 + 64 * 1024;
async function send(value: object) {
  if (parentGone) return;
  await new Promise<void>((resolve) =>
    outgoing.write(
      `${JSON.stringify({ ...value, nonce: start?.nonce, sequence: ++sequence })}\n`,
      (error) => {
        if (error) {
          parentGone = true;
          void stop();
        }
        resolve();
      },
    ),
  );
}
async function stopTree() {
  const proof = await coalition!.stopTree(start?.graceMs ?? 200);
  return {
    groupStopped: proof.confirmed,
    processTreeStopped: proof.confirmed,
    terminalTaskCount: proof.confirmed ? 1 : null,
    forced: proof.forced,
  };
}
function stop(): Promise<void> {
  cancelling = true;
  if (closing) return closing;
  closing = (async () => {
    if (!launchdOwned) {
      if (bridgeStarting) {
        try {
          await bridgeStarting;
          bridge!.stop();
          await bridge!.finished;
        } catch {
          await send({ type: 'terminal', groupStopped: false, server: null });
          process.exit(125);
        }
      } else process.exit(0);
      return;
    }
    const proof = await stopTree();
    if (proof.groupStopped) await exited;
    else {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }
    await drained?.catch(() => {});
    await send({ type: 'terminal', ...proof, server: evidence(), guardian: guardianEvidence });
    coalition!.close();
    if (parentGone && proof.groupStopped) {
      try {
        removeRuntimeTemp(control!.registration.root);
        await removeLaunchdRegistration(control!.registration);
      } catch {
        process.exit(125);
      }
    }
    process.exit(proof.groupStopped ? 0 : 125);
  })();
  return closing;
}
async function run() {
  const input = start!;
  if (!launchdOwned) {
    bridgeStarting = (async () => {
      bridge = await startLaunchdSupervisor({
        kind: 'mcp',
        frame: input as unknown as Record<string, unknown>,
        controlBase: input.controlBase,
        cancelled: () => cancelling || parentGone,
        async onFrame(frame) {
          if (frame.sequence !== guardianSequence + 1) throw Error('mcp_guardian_sequence_invalid');
          guardianSequence++;
          if (frame.type === 'ready') await send({ ...frame, broker: brokerIdentity });
          else if (frame.type === 'terminal') {
            const guardian = frame.guardian as McpStdioProcessRecord | undefined;
            await send({
              ...frame,
              ...(guardian
                ? { guardian: { ...guardian, kernelState: mcpStdioKernelState(guardian) } }
                : {}),
            });
          } else await send(frame);
        },
      });
    })();
    try {
      await bridgeStarting;
      await bridge!.finished;
      process.exit(0);
    } catch {
      await send({ type: 'terminal', groupStopped: false, server: null });
      process.exit(125);
    }
  }
  try {
    child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const current = child;
    current.stdin!.on('error', () => void stop());
    exited = new Promise((resolve) => {
      current.once('exit', (code, signal) => {
        serverExit = { code, signal, reaped: true };
        if (serverEvidence) serverEvidence.exit = serverExit;
        resolve();
      });
      current.once('error', () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      current.once('spawn', resolve);
      current.once('error', reject);
    });
    serverEvidence = {
      ...observeMcpStdioIdentity(current.pid!),
      exit: serverExit,
      kernelState: 'unavailable',
    };
    let stderrBytes = 0;
    drained = Promise.all([
      (async () => {
        for await (const raw of current.stdout!) {
          const chunk = raw as Buffer;
          for (let offset = 0; offset < chunk.length; offset += 16384)
            await send({
              type: 'rpc',
              content: chunk.subarray(offset, offset + 16384).toString('base64'),
            });
        }
      })(),
      (async () => {
        for await (const raw of current.stderr!) {
          stderrBytes += (raw as Buffer).length;
          if (stderrBytes > input.stderrBytes) {
            void stop();
            return;
          }
        }
      })(),
    ]);
    void drained.catch(() => void stop());
    guardianEvidence = {
      ...observeMcpStdioIdentity(process.pid),
      exit: null,
      kernelState: 'alive',
    };
    await send({
      type: 'ready',
      processGroupId: current.pid,
      guardianPid: process.pid,
      guardian: guardianEvidence,
      server: evidence(),
      coalition: coalition!.identity,
    });
    if (cancelling) {
      closing = undefined;
      await stop();
      return;
    }
    await exited;
    if (closing) await closing;
    else await stop();
  } catch {
    await stop();
  }
}
incoming.on('data', (chunk: Buffer) => {
  try {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset),
        end = newline < 0 ? chunk.length : newline;
      if (buffer.length + end - offset > CONTROL) throw new Error('control_limit');
      buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
      if (newline < 0) break;
      const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (!start) {
        if (
          frame.type !== 'start' ||
          typeof frame.nonce !== 'string' ||
          !isAbsolute(frame.command) ||
          !isAbsolute(frame.cwd) ||
          !isAbsolute(frame.controlBase) ||
          !Array.isArray(frame.args) ||
          frame.args.some((x: unknown) => typeof x !== 'string') ||
          !frame.env ||
          typeof frame.env !== 'object' ||
          Array.isArray(frame.env) ||
          Object.values(frame.env).some((x) => typeof x !== 'string') ||
          !Number.isSafeInteger(frame.graceMs) ||
          frame.graceMs < 0 ||
          frame.graceMs > 5000 ||
          !Number.isSafeInteger(frame.stderrBytes) ||
          frame.stderrBytes < 1 ||
          !Number.isSafeInteger(frame.frameBytes) ||
          frame.frameBytes < 1 ||
          process.platform !== 'darwin'
        )
          throw new Error('start_invalid');
        start = frame;
        void run();
      } else if (frame.nonce !== start.nonce) throw new Error('control_identity');
      else if (frame.type === 'cancel') void stop();
      else if (
        frame.type === 'rpc' &&
        typeof frame.content === 'string' &&
        Buffer.byteLength(frame.content) <= start.frameBytes + 1 &&
        !cancelling
      ) {
        if (!launchdOwned) {
          incoming.pause();
          void bridgeStarting!
            .then(() => bridge!.send(frame))
            .then(
              () => incoming.resume(),
              () => void stop(),
            );
        } else if (child?.stdin?.writable) {
          if (!child.stdin.write(frame.content)) {
            incoming.pause();
            child.stdin.once('drain', () => incoming.resume());
          }
        } else throw new Error('control_closed');
      } else throw new Error('control_invalid');
    }
  } catch {
    parentGone = true;
    void stop();
  }
});
for (const event of ['end', 'error'] as const)
  incoming.on(event, () => {
    parentGone = true;
    void stop();
  });
outgoing.on('error', () => {
  parentGone = true;
  void stop();
});
process.on('SIGTERM', () => {
  parentGone = true;
  void stop();
});
