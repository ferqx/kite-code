#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

/** Stable launcher contract. Keep this source independent from the application bundle. */
export const STABLE_LAUNCHER_CONTRACT_ = 'kite-stable-release-launcher-v1' as const;
const CANDIDATE_ID = /^[a-f0-9]{24}$/u;
const ACTIVE_POINTER_FILE = 'active';
const MAX_POINTER_BYTES = 64;
const MCP_STDIO_WRAPPER_ENTRYPOINT = '--kite-internal-mcp-stdio-v1';
const RUNTIME_CONTROL_FRAME_SCHEMA = 'kite.runtime-control-frame.v1';
const MCP_STDIO_CONTROL_DOMAIN = 'mcp-stdio-v1';
const MCP_STDIO_WRAPPER_PEER_ID = 'mcp-stdio-wrapper';
const MAX_MCP_CONTROL_LINE_BYTES = 1_048_576;

interface ManagedRunTarget {
  readonly command: 'service' | 'coordinator' | 'worker' | 'web-gateway';
  readonly readinessEnvironmentVariable:
    | 'KITE_SERVICE_READINESS_FD'
    | 'KITE_COORDINATOR_READY_FD'
    | 'KITE_WORKER_READY_FD'
    | 'KITE_WEB_GATEWAY_READY_FD';
}

const MANAGED_RUN_TARGETS: Readonly<Record<string, ManagedRunTarget>> = Object.freeze({
  'kite-service': {
    command: 'service',
    readinessEnvironmentVariable: 'KITE_SERVICE_READINESS_FD',
  },
  'kite-coordinator': {
    command: 'coordinator',
    readinessEnvironmentVariable: 'KITE_COORDINATOR_READY_FD',
  },
  'kite-worker': {
    command: 'worker',
    readinessEnvironmentVariable: 'KITE_WORKER_READY_FD',
  },
  'kite-web-gateway': {
    command: 'web-gateway',
    readinessEnvironmentVariable: 'KITE_WEB_GATEWAY_READY_FD',
  },
});

export interface StableLauncherReadinessForwarding {
  readonly environmentVariable: ManagedRunTarget['readinessEnvironmentVariable'];
  readonly fd: 3;
}

/**
 * Validate the only managed process invocations accepted by a stable companion launcher.
 * CLI/TUI launchers intentionally remain argument-transparent; process companions do not.
 * Readiness must be the manager-owned fd 3 marker so a direct or ambiguous invocation cannot
 * accidentally dispatch to the Service/Coordinator/Worker/Gateway child.
 */
export function resolveReadinessForwarding(
  executableName: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): StableLauncherReadinessForwarding | undefined {
  const target = MANAGED_RUN_TARGETS[stripExecutableSuffix(executableName)];
  if (target === undefined) return undefined;
  const expected = [target.command, 'run'] as const;
  if (args.length !== expected.length || args.some((value, index) => value !== expected[index])) {
    throw new Error(
      `Stable ${target.command} launcher requires the exact \`${target.command} run\` arguments.`,
    );
  }
  if (environment[target.readinessEnvironmentVariable] !== '3') {
    throw new Error(
      `Stable ${target.command} launcher requires manager-owned fd 3 readiness forwarding.`,
    );
  }
  return Object.freeze({
    environmentVariable: target.readinessEnvironmentVariable,
    fd: 3,
  });
}

function stripExecutableSuffix(name: string): string {
  return name.endsWith('.exe') ? name.slice(0, -'.exe'.length) : name;
}

async function main(): Promise<void> {
  const executable = realpathSync.native(process.execPath);
  const binRoot = dirname(executable);
  const installRoot = dirname(binRoot);
  const name = basename(executable);
  const activePath = join(installRoot, ACTIVE_POINTER_FILE);
  assertRegularFile(activePath, 'active release pointer');
  const pointerBytes = readFileSync(activePath);
  if (pointerBytes.byteLength > MAX_POINTER_BYTES) {
    throw new Error('Active release pointer is too large.');
  }
  const candidateId = pointerBytes.toString('utf8').trim();
  if (!CANDIDATE_ID.test(candidateId) || pointerBytes.toString('utf8') !== `${candidateId}\n`) {
    throw new Error('Active release pointer is invalid.');
  }

  const candidateRoot = join(installRoot, 'releases', candidateId);
  assertDirectory(candidateRoot, 'active release root');
  const candidateIdPath = join(candidateRoot, '.candidate-id');
  assertRegularFile(candidateIdPath, 'active release identity');
  if (readFileSync(candidateIdPath, 'utf8') !== `${candidateId}\n`) {
    throw new Error('Active release identity does not match its pointer.');
  }

  const target = join(candidateRoot, 'bin', name);
  assertRegularFile(target, 'active release executable');
  if (!isPathWithin(candidateRoot, realpathSync.native(target))) {
    throw new Error('Active release executable escaped its candidate root.');
  }

  // Bun standalone preserves the executable slot in argv[0] and argv[1]; the
  // application entrypoints consistently consume user arguments from index 2.
  const args = process.argv.slice(2);
  const env = {
    ...process.env,
    KITE_CODE_RELEASE_ROOT: candidateRoot,
    KITE_CODE_CANDIDATE_ID: candidateId,
    KITE_STANDALONE_EXECUTABLE: '1',
  };
  if (args.includes(MCP_STDIO_WRAPPER_ENTRYPOINT)) {
    if (
      args.length !== 1 ||
      args[0] !== MCP_STDIO_WRAPPER_ENTRYPOINT ||
      stripExecutableSuffix(name) !== 'kite-service'
    ) {
      throw new Error('Stable MCP wrapper invocation is not exact or is bound to the wrong slot.');
    }
    process.exitCode = await runMcpWrapper(target, args, env);
    return;
  }

  const readiness = resolveReadinessForwarding(name, args, process.env);
  const childEnv = readiness === undefined ? env : { ...env, [readiness.environmentVariable]: '3' };
  const child =
    readiness !== undefined
      ? process.platform === 'win32'
        ? Bun.spawn([target, ...args], {
            stdio: ['inherit', 'inherit', 'inherit', 3] as [
              'inherit',
              'inherit',
              'inherit',
              number,
            ],
            env: childEnv,
          })
        : Bun.spawn([target, ...args], {
            stdio: ['inherit', 'inherit', 'inherit', Bun.file('/dev/fd/3')],
            env: childEnv,
          })
      : Bun.spawn([target, ...args], { stdio: ['inherit', 'inherit', 'inherit'], env: childEnv });
  process.exitCode = await child.exited;
}

async function runMcpWrapper(
  target: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const child = Bun.spawn([target, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env,
  });
  if (!child.stdin || !child.stdout) throw new Error('Stable MCP launcher pipes are unavailable.');
  const inputPump = forwardInput(child.stdin);
  const outputPump = forwardOutput(child.stdout);
  const [exitCode] = await Promise.all([child.exited, inputPump, outputPump]);
  return exitCode;
}

interface LaunchInputSink {
  write(data: Uint8Array): number | Promise<number>;
  end(): void;
}

async function forwardInput(target: LaunchInputSink): Promise<void> {
  for await (const chunk of process.stdin) {
    await target.write(chunk as Uint8Array);
  }
  target.end();
}

async function forwardOutput(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      if (Buffer.byteLength(pending, 'utf8') > MAX_MCP_CONTROL_LINE_BYTES * 2) {
        throw new Error('Stable MCP launcher output exceeded its bounded buffer.');
      }
      while (true) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        await writeOutput(rewriteMcpControlFrame(line));
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) await writeOutput(rewriteMcpControlFrame(pending));
  } finally {
    reader.releaseLock();
  }
}

function rewriteMcpControlFrame(line: string): string {
  if (Buffer.byteLength(line, 'utf8') > MAX_MCP_CONTROL_LINE_BYTES) {
    throw new Error('Stable MCP launcher control frame exceeded its bound.');
  }
  if (!line.endsWith('\n')) return line;
  const body = line.slice(0, -1);
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return line;
  }
  if (!isRecord(value)) return line;
  const payload = value.payload;
  if (
    value.schema !== RUNTIME_CONTROL_FRAME_SCHEMA ||
    value.domain !== MCP_STDIO_CONTROL_DOMAIN ||
    value.peerId !== MCP_STDIO_WRAPPER_PEER_ID ||
    !isRecord(payload) ||
    (payload.type !== 'ready' && payload.type !== 'terminal') ||
    typeof payload.wrapperPid !== 'number'
  ) {
    return line;
  }
  payload.wrapperPid = process.pid;
  return `${JSON.stringify(value)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeOutput(value: string): Promise<void> {
  if (!process.stdout.write(value)) {
    await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
  }
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing.`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is unsafe.`);
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing.`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is unsafe.`);
}

function isPathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `[kite-release-launcher] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
